// Pre-flight model checks for colony runs.
// Fail fast with a clear message if the selected model is missing or doesn't
// support tool calling. Previously the colony would silently produce garbage
// when the user picked a non-tool-capable model.
const { stripProviderPrefix } = require('../agentParser');
const { normalizeOllamaUrl } = require('../ollamaUrl');
const colonyModels = require('../colonyModels');
const protocol = require('../colonyProtocol');
const { gitCheckoutBranch } = require('./git');

async function preflightColony(model, ollamaUrl) {
  const providers = require('../providers');
  const { provider } = providers.parseModel(model);
  const normalizedOllamaUrl = normalizeOllamaUrl(ollamaUrl);

  // Cloud providers: no Ollama checks. Just confirm a key is configured — the
  // chosen models are tool-capable, so the Ollama capability gate doesn't apply.
  if (provider !== 'ollama') {
    if (!providers.hasKey(provider)) {
      return { ok: false, error: `${provider} API key not set. Add it in Settings → Model Providers, then try again.` };
    }
    return { ok: true };
  }

  const stripped = stripProviderPrefix(model);

  // 1. Ollama reachable?
  let tagsRes;
  try {
    tagsRes = await fetch(`${normalizedOllamaUrl}/api/tags`);
  } catch (e) {
    const code = e.cause?.code;
    if (code === 'ECONNREFUSED') {
      return { ok: false, error: `Cannot reach Ollama at ${normalizedOllamaUrl}. Start Ollama with "ollama serve" and try again.` };
    }
    return { ok: false, error: `Cannot reach Ollama at ${normalizedOllamaUrl}: ${e.message}` };
  }
  if (!tagsRes.ok) return { ok: false, error: `Ollama returned HTTP ${tagsRes.status} from /api/tags` };
  const tags = await tagsRes.json();

  // 2. Model installed?
  const models = Array.isArray(tags.models) ? tags.models : [];
  const found = models.some(m => m.name === stripped || m.name === `${stripped}:latest` || m.name.startsWith(`${stripped}:`));
  if (!found) {
    const available = models.map(m => m.name).slice(0, 8).join(', ') || '(none)';
    return {
      ok: false,
      error: `Model "${stripped}" is not installed on Ollama. Pull it with "ollama pull ${stripped}". Currently installed: ${available}`,
    };
  }

  // 3. Tool-calling capability. Many popular models (vanilla llama3, gemma) don't
  // support tools and the orchestrator needs tool calls to function at all. Older
  // Ollama versions may not return a capabilities array — in that case we skip
  // the check rather than false-reject.
  try {
    const showRes = await fetch(`${normalizedOllamaUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: stripped }),
    });
    if (showRes.ok) {
      const info = await showRes.json();
      const caps = Array.isArray(info.capabilities) ? info.capabilities : null;
      if (caps && caps.length > 0 && !caps.includes('tools')) {
        return {
          ok: false,
          error: `Model "${stripped}" does not support tool calling (capabilities: ${caps.join(', ')}). Colony requires a tool-capable model — try llama3.1, qwen2.5, qwen3, mistral-nemo, or mistral-small.`,
        };
      }
    }
  } catch {
    // Non-fatal — skip capability check if /api/show misbehaves.
  }

  return { ok: true };
}

// Run the full pre-flight for a colony: cloud-model gating, per-model capability
// checks, git colony-branch checkout, and the weak-tool-model soft warning.
// Throws on a hard gate/capability failure. Sets `state.githubWriteback` and
// returns the resolved operator model. `ctx` = { colonyId, row, modelPlan,
//   colonyBranch, ollamaUrl, addEntry, onEvent, state }.
async function runModelPreflightAndCheckout(ctx) {
  const { colonyId, row, modelPlan, colonyBranch, ollamaUrl, addEntry, onEvent, state } = ctx;

  const cloudEnabled = !!row.cloud_enabled;
  const operatorModel = (modelPlan && modelPlan.operator) || row.model;

  // ── Pre-flight: gate cloud models, then check every distinct model used ──
  const planGate = colonyModels.gatePlan({ operator: operatorModel, ...(modelPlan || {}) }, cloudEnabled);
  if (!planGate.ok) throw new Error(planGate.error);

  const modelsToCheck = [...new Set([
    operatorModel,
    ...(modelPlan ? Object.values(modelPlan) : []),
  ].filter(Boolean))];
  for (const m of modelsToCheck) {
    addEntry({ kind: 'preflight', message: `Checking model "${stripProviderPrefix(m)}"…` });
    const pf = await preflightColony(m, ollamaUrl);
    if (!pf.ok) throw new Error(pf.error);
  }
  addEntry({ kind: 'preflight', message: `Models ready (${modelsToCheck.length}) — tool calling supported.` });

  // ── Git write-back: checkout colony branch pre-flight ────────────────────
  state.githubWriteback = !!row.github_writeback;
  if (state.githubWriteback && row.repo_path) {
    try {
      gitCheckoutBranch(row.repo_path, colonyBranch);
      addEntry({ kind: 'preflight', message: `🌿 Checked out branch "${colonyBranch}" — agents will commit work here.` });
    } catch (gitErr) {
      // Non-fatal: emit HITL blocker, store it on the blackboard, but continue
      // running so agents can still do work. They just won't have a dedicated branch.
      const msg = `Failed to checkout git branch "${colonyBranch}": ${gitErr.message}\n\nTo fix: open a terminal, navigate to ${row.repo_path}, run "git checkout -b ${colonyBranch}", then click "Retry" in the colony panel.`;
      addEntry({ kind: 'preflight', message: `⚠️ ${msg}` });
      protocol.writeBlackboard(colonyId, 'system', 'blocker', msg, { action_required: 'fix_git_branch', branch: colonyBranch, repo_path: row.repo_path });
      onEvent({ type: 'blocker', blocker: { message: msg, action: 'fix_git_branch', branch: colonyBranch } });
    }
  }

  // Soft warning for models known to describe tool calls in text instead of
  // invoking them properly. The text parser in agentTools.js will compensate,
  // but results may be less reliable than with a tool-native model.
  const weakToolModels = /^llama3(\.|:)|^llama-3(\.|:)|^mistral(?!-nemo|-small)/i;
  if (weakToolModels.test(stripProviderPrefix(row.model))) {
    addEntry({
      kind: 'preflight',
      message: `⚠ ${stripProviderPrefix(row.model)} has limited multi-step tool-calling reliability. Colony will attempt a text-based tool call fallback, but for best results use qwen2.5, qwen3, or mistral-nemo.`,
    });
  }

  return { operatorModel };
}

module.exports = { preflightColony, runModelPreflightAndCheckout };
