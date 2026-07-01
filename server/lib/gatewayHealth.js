const providers = require('./providers');
const { logger } = require('./logger');

const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 30_000;

let lastStatus = {
  enabled: false,
  reachable: null,
  checked_at: null,
  message: 'LLM gateway is not configured',
};

function nowIso() {
  return new Date().toISOString();
}

function healthUrl(baseUrl) {
  const root = String(baseUrl || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  // /health/readiness answers from the proxy itself in milliseconds. Plain
  // /health fans out live test calls to every upstream provider and routinely
  // blows past the probe timeout when auth is valid.
  return root ? `${root}/health/readiness` : '';
}

function publicStatus(gw, status = lastStatus) {
  if (!gw.enabled) {
    return {
      enabled: false,
      reachable: null,
      checked_at: status.checked_at,
      message: 'LLM gateway is not configured',
    };
  }
  return {
    enabled: true,
    reachable: status.reachable,
    checked_at: status.checked_at,
    message: status.message,
  };
}

async function probeGateway({ force = false, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const gw = providers.gatewayConfig();
  if (!gw.enabled) {
    lastStatus = publicStatus(gw, lastStatus);
    return lastStatus;
  }

  const age = lastStatus.checked_at ? Date.now() - Date.parse(lastStatus.checked_at) : Infinity;
  if (!force && lastStatus.enabled && age < CACHE_TTL_MS) return publicStatus(gw, lastStatus);

  const url = healthUrl(gw.url);
  try {
    const res = await fetch(url, {
      headers: gw.key ? { Authorization: `Bearer ${gw.key}` } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    lastStatus = {
      enabled: true,
      reachable: !!res.ok,
      checked_at: nowIso(),
      message: res.ok ? 'Gateway reachable' : `Gateway health check returned HTTP ${res.status}`,
    };
  } catch (error) {
    lastStatus = {
      enabled: true,
      reachable: false,
      checked_at: nowIso(),
      message: `Gateway unreachable: ${error.message || String(error)}`,
    };
  }

  if (lastStatus.reachable) {
    logger.info('gateway', 'health_ok');
  } else {
    logger.warn('gateway', 'health_unreachable', { message: lastStatus.message });
  }
  return publicStatus(gw, lastStatus);
}

function getGatewayStatus() {
  return publicStatus(providers.gatewayConfig(), lastStatus);
}

function _resetForTests() {
  lastStatus = {
    enabled: false,
    reachable: null,
    checked_at: null,
    message: 'LLM gateway is not configured',
  };
}

module.exports = {
  healthUrl,
  probeGateway,
  getGatewayStatus,
  _resetForTests,
};
