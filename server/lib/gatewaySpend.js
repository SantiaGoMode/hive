const db = require('../db');
const providers = require('./providers');
const { logSwallowed } = require('./logSwallowed');

const FETCH_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 30_000;

let lastSummary = null;

function nowIso() {
  return new Date().toISOString();
}

function gatewayRoot(baseUrl) {
  return String(baseUrl || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseJsonMaybe(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function rowMetadata(row) {
  const metadata = parseJsonMaybe(row.metadata || row.request_metadata || row.spend_logs_metadata);
  return metadata.spend_logs_metadata || metadata;
}

function cacheHit(row) {
  if (row.cache_hit === true || row.cache_hit === 'true') return true;
  if (row.cache_hit === 1 || row.cache_hit === '1') return true;
  if (row.cache_status === 'hit' || row.cache_hit_status === 'hit') return true;
  return false;
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.spend_logs)) return payload.spend_logs;
  if (Array.isArray(payload?.logs)) return payload.logs;
  return [];
}

function agentRows() {
  try {
    return db.prepare('SELECT id, name, gateway_budget_usd FROM agents ORDER BY name COLLATE NOCASE').all();
  } catch (error) {
    logSwallowed('gatewaySpend:agentRows', error);
    return [];
  }
}

function emptySummary(gw, message = 'Gateway spend data is unavailable') {
  return {
    enabled: !!gw.enabled,
    reachable: null,
    checked_at: nowIso(),
    persistence: {
      spend_logs_reachable: false,
      observed_rows: 0,
      message,
    },
    totals: {
      spend_usd: 0,
      tokens: 0,
      calls: 0,
      cache_hit_rate: null,
    },
    agents: agentRows().map(agent => ({
      agent_id: agent.id,
      agent_name: agent.name,
      spend_usd: 0,
      tokens: 0,
      calls: 0,
      budget_usd: agent.gateway_budget_usd == null ? null : numberValue(agent.gateway_budget_usd),
      budget_remaining_usd: agent.gateway_budget_usd == null ? null : numberValue(agent.gateway_budget_usd),
      cache_hit_rate: null,
    })),
  };
}

function summarizeRows(rows) {
  const localAgents = agentRows();
  const byId = new Map();
  for (const agent of localAgents) {
    byId.set(agent.id, {
      agent_id: agent.id,
      agent_name: agent.name,
      spend_usd: 0,
      tokens: 0,
      calls: 0,
      cache_hits: 0,
      budget_usd: agent.gateway_budget_usd == null ? null : numberValue(agent.gateway_budget_usd),
    });
  }

  for (const row of rows) {
    const meta = rowMetadata(row);
    const agentId = meta.agent_id || row.agent_id || row.user || row.end_user || 'unattributed';
    const existing = byId.get(agentId) || {
      agent_id: agentId,
      agent_name: meta.agent_name || row.agent_name || agentId,
      spend_usd: 0,
      tokens: 0,
      calls: 0,
      cache_hits: 0,
      budget_usd: null,
    };
    existing.agent_name = existing.agent_name || meta.agent_name || agentId;
    existing.spend_usd += numberValue(row.spend || row.cost || row.total_spend);
    const totalTokens = row.total_tokens ?? row.tokens;
    existing.tokens += totalTokens == null
      ? numberValue(row.prompt_tokens) + numberValue(row.completion_tokens)
      : numberValue(totalTokens);
    existing.calls += 1;
    if (cacheHit(row)) existing.cache_hits += 1;
    byId.set(agentId, existing);
  }

  let totalSpend = 0;
  let totalTokens = 0;
  let totalCalls = 0;
  let totalCacheHits = 0;

  const agents = [...byId.values()]
    .map(agent => {
      totalSpend += agent.spend_usd;
      totalTokens += agent.tokens;
      totalCalls += agent.calls;
      totalCacheHits += agent.cache_hits;
      const budget = agent.budget_usd;
      const remaining = budget == null ? null : Math.max(0, budget - agent.spend_usd);
      return {
        agent_id: agent.agent_id,
        agent_name: agent.agent_name,
        spend_usd: Number(agent.spend_usd.toFixed(6)),
        tokens: agent.tokens,
        calls: agent.calls,
        budget_usd: budget,
        budget_remaining_usd: remaining == null ? null : Number(remaining.toFixed(6)),
        cache_hit_rate: agent.calls > 0 ? Number((agent.cache_hits / agent.calls).toFixed(4)) : null,
      };
    })
    .sort((a, b) => b.spend_usd - a.spend_usd || a.agent_name.localeCompare(b.agent_name));

  return {
    totals: {
      spend_usd: Number(totalSpend.toFixed(6)),
      tokens: totalTokens,
      calls: totalCalls,
      cache_hit_rate: totalCalls > 0 ? Number((totalCacheHits / totalCalls).toFixed(4)) : null,
    },
    agents,
  };
}

async function fetchSpendLogs(gw, limit) {
  const root = gatewayRoot(gw.url);
  if (!root) return [];
  const res = await fetch(`${root}/spend/logs?limit=${encodeURIComponent(limit)}`, {
    headers: gw.key ? { Authorization: `Bearer ${gw.key}` } : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const error = new Error(`Gateway spend logs returned HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return rowsFromPayload(await res.json());
}

// Translate a fetch failure into an instruction the Settings panel can show —
// the raw error still goes to logSwallowed for debugging.
function spendUnavailableMessage(error) {
  if (error?.status === 401 || error?.status === 403) {
    return `The gateway rejected Hive's key (HTTP ${error.status}). Enter your LiteLLM master key as the LLM Gateway key in Settings → Model Providers (or set LLM_GATEWAY_KEY) — spend is only tracked for authenticated requests.`;
  }
  if (error?.status) {
    return `Gateway spend logs returned HTTP ${error.status}. Spend tracking requires the LiteLLM master key and the Postgres service — see gateway/README.md “Spend tracking & budgets”.`;
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return 'The gateway did not respond in time. Check that the LiteLLM container is running (gateway/run-gateway.sh) and the gateway URL is correct.';
  }
  return 'Could not reach the gateway at the configured URL. Check that the LiteLLM container is running (gateway/run-gateway.sh) and the gateway URL is correct.';
}

async function getGatewaySpendSummary({ force = false, limit = 500 } = {}) {
  const gw = providers.gatewayConfig();
  if (!gw.enabled) return emptySummary(gw, 'LLM gateway is not configured');

  const age = lastSummary?.checked_at ? Date.now() - Date.parse(lastSummary.checked_at) : Infinity;
  if (!force && lastSummary && age < CACHE_TTL_MS) return lastSummary;

  try {
    const rows = await fetchSpendLogs(gw, limit);
    const summary = summarizeRows(rows);
    lastSummary = {
      enabled: true,
      reachable: true,
      checked_at: nowIso(),
      persistence: {
        spend_logs_reachable: true,
        observed_rows: rows.length,
        message: rows.length
          ? 'Gateway SpendLogs are reachable and returning persisted rows'
          : 'Gateway SpendLogs are reachable; no spend rows returned yet',
      },
      ...summary,
    };
    return lastSummary;
  } catch (error) {
    logSwallowed('gatewaySpend:fetchSpendLogs', error);
    lastSummary = emptySummary(gw, spendUnavailableMessage(error));
    lastSummary.reachable = false;
    return lastSummary;
  }
}

function _resetForTests() {
  lastSummary = null;
}

module.exports = {
  gatewayRoot,
  getGatewaySpendSummary,
  _resetForTests,
};
