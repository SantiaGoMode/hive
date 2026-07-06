// Setup wizard status — one aggregated snapshot of every dependency the
// first-run wizard cares about. Each probe is independently guarded so a
// missing tool can never break the endpoint, and shell-outs are cached the
// same way config.githubCliToken is (they change rarely, spawning is slow).
const { execFile } = require('child_process');
const config = require('./config');
const providers = require('./providers');
const gatewayHealth = require('./gatewayHealth');
const sandbox = require('./sandbox');
const { getOllamaUrl, ollamaApiUrl } = require('./ollamaUrl');

const TOOL_TTL = 60_000; // ms
const toolCache = new Map(); // cmd -> { at, value }

function probeTool(cmd, args = ['--version']) {
  const cached = toolCache.get(cmd);
  if (cached && Date.now() - cached.at < TOOL_TTL) return Promise.resolve(cached.value);
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3_000 }, (err, stdout) => {
      const value = err
        ? { present: false }
        : { present: true, version: String(stdout || '').split('\n')[0].trim() };
      toolCache.set(cmd, { at: Date.now(), value });
      resolve(value);
    });
  });
}

async function probeOllama() {
  const url = getOllamaUrl();
  const out = { reachable: false, url, version: null, installed_models: 0 };
  try {
    const r = await fetch(ollamaApiUrl('version'), { signal: AbortSignal.timeout(2_000) });
    if (!r.ok) return out;
    out.reachable = true;
    out.version = (await r.json()).version || null;
  } catch {
    return out; /* Ollama down is a normal state the wizard reports */
  }
  try {
    const r = await fetch(ollamaApiUrl('tags'), { signal: AbortSignal.timeout(2_000) });
    if (r.ok) out.installed_models = ((await r.json()).models || []).length;
  } catch { /* version reachable but tags failing — keep reachable:true */ }
  return out;
}

// Every probe can be overridden for tests; defaults are the real ones.
async function getSetupStatus(overrides = {}) {
  const probes = {
    ollama: probeOllama,
    docker: () => sandbox.capabilities(),
    tool: probeTool,
    githubToken: () => config.githubToken(),
    keyFor: (p) => providers.keyFor(p),
    gateway: () => ({
      configured: providers.gatewayConfig().enabled,
      ...gatewayHealth.getGatewayStatus(),
    }),
    ...overrides,
  };

  const guard = async (fn, fallback) => {
    try { return await fn(); } catch { return fallback; }
  };

  const [ollama, git, gh, npx, uvx] = await Promise.all([
    guard(probes.ollama, { reachable: false, url: getOllamaUrl(), version: null, installed_models: 0 }),
    guard(() => probes.tool('git'), { present: false }),
    guard(() => probes.tool('gh'), { present: false }),
    guard(() => probes.tool('npx'), { present: false }),
    guard(() => probes.tool('uvx'), { present: false }),
  ]);

  const docker = await guard(probes.docker, { docker: false, ready: false });

  return {
    setup_completed: config.getSetting('setup_completed') === 'true',
    ollama,
    docker: { available: !!docker.docker, sandbox_ready: !!docker.ready },
    git,
    gh: { ...gh, authenticated: !!(await guard(probes.githubToken, null)) },
    npx: { present: npx.present },
    uvx: { present: uvx.present },
    providers: {
      anthropic: !!(await guard(() => probes.keyFor('anthropic'), '')),
      openai: !!(await guard(() => probes.keyFor('openai'), '')),
      gemini: !!(await guard(() => probes.keyFor('gemini'), '')),
    },
    gateway: await guard(probes.gateway, { configured: false, reachable: null }),
  };
}

function _resetToolCacheForTests() {
  toolCache.clear();
}

module.exports = { getSetupStatus, _resetToolCacheForTests };
