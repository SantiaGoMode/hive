const express = require('express');
const router  = express.Router();
const db      = require('../db');
const ngrokService = require('../lib/ngrokService');
const { getSystemMemory } = require('../lib/systemMemory');
const { getOllamaUrl, ollamaApiUrl } = require('../lib/ollamaUrl');
const { settingSecret } = require('../lib/secrets');
const { assertCanExposePublicly } = require('../lib/auth');
const { getRecentLogs } = require('../lib/logger');
const colonyRunner = require('../lib/colonyRunner');
const scheduler = require('../lib/scheduler');
const schedulerLifecycle = require('../lib/schedulerLifecycle');
const staffScheduler = require('../lib/staffScheduler');
const providers = require('../lib/providers');
const gatewayHealth = require('../lib/gatewayHealth');
const gatewaySpend = require('../lib/gatewaySpend');
const setupStatus = require('../lib/setupStatus');
const { invalidateSettingsCache } = require('../lib/config');

// Read a value from a source, swallowing any failure so /metrics never 500s on
// one bad source.
function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

// GET /api/system/status — RAM + running Ollama models
router.get('/status', async (req, res) => {
  const memory = getSystemMemory();

  let models = [];
  let ollamaReachable = false;
  const ollamaUrl = getOllamaUrl();

  try {
    const r = await fetch(ollamaApiUrl('ps'), { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const data = await r.json();
      models = data.models || [];
      ollamaReachable = true;
    }
  } catch {} /* Ollama down is normal — reported as ollama_reachable:false */

  res.json({
    memory,
    models,
    ollama_reachable: ollamaReachable,
    ollama_url: ollamaUrl,
  });
});

// GET /api/system/metrics — operational snapshot for the health dashboard (#7).
// Cheap and non-hanging: a short Ollama probe, gateway config (no live probe),
// background-task counts, and recent warnings/errors from the logger ring
// buffer. Each source is guarded so one failure can't break the endpoint, and
// no secrets are returned (the gateway key/url-with-creds is never included).
router.get('/metrics', async (req, res) => {
  let ollamaReachable = false;
  let loadedModels = 0;
  let loadedModelDetails = [];
  try {
    const r = await fetch(ollamaApiUrl('ps'), { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const models = (await r.json()).models || [];
      loadedModels = models.length;
      loadedModelDetails = models.map(m => ({
        name: m.name,
        model: m.model,
        size: m.size,
        size_vram: m.size_vram,
        expires_at: m.expires_at,
        parameter_size: m.details?.parameter_size,
        quantization_level: m.details?.quantization_level,
      }));
      ollamaReachable = true;
    }
  } catch { /* Ollama down → reachable:false */ }

  const gw = safe(() => providers.gatewayConfig(), { enabled: false });
  const gatewayStatus = gw.enabled
    ? await gatewayHealth.probeGateway()
    : gatewayHealth.getGatewayStatus();
  const spend = await gatewaySpend.getGatewaySpendSummary();

  res.json({
    uptime_s: Math.round(process.uptime()),
    pid: process.pid,
    node_version: process.version,
    hive_version: safe(() => require('../../package.json').version, null),
    memory: safe(() => getSystemMemory(), null),
    active_colony_runs: safe(() => colonyRunner.activeRunCount(), null),
    active_pipeline_runs: safe(() => require('../lib/pipelineRunner').activeRunCount(), null),
    scheduled_tasks: safe(() => scheduler.scheduledCount(), null),
    staff_scheduler: safe(() => staffScheduler.status(), null),
    scheduler_lifecycle: safe(() => schedulerLifecycle.statuses(), null),
    ollama: { reachable: ollamaReachable, url: getOllamaUrl(), loaded_models: loadedModels, loaded_model_details: loadedModelDetails },
    gateway: { ...gatewayStatus, spend }, // sanitized: never expose gateway url/key
    recent_logs: safe(() => getRecentLogs(50), []),
  });
});

// GET /api/system/setup — aggregated dependency snapshot for the first-run
// setup wizard: Ollama, Docker, CLI tools, provider keys, gateway.
router.get('/setup', async (req, res) => {
  res.json(await setupStatus.getSetupStatus());
});

// POST /api/system/setup/complete — mark the wizard finished (also used by
// "Skip"); re-runnable from Settings by just visiting /setup again.
router.post('/setup/complete', (req, res) => {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('setup_completed', 'true')").run();
  invalidateSettingsCache();
  res.json({ ok: true });
});

// POST /api/system/model/stop — unload a model from Ollama memory
router.post('/model/stop', async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'model is required' });

  const ollamaUrl = getOllamaUrl();
  try {
    // keep_alive: 0 instructs Ollama to evict the model immediately
    await fetch(`${ollamaUrl}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, keep_alive: 0 }),
      signal:  AbortSignal.timeout(8000),
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── NGROK ─────────────────────────────────────────────────────────────────────

router.post('/ngrok/start', async (req, res) => {
  try {
    const authtoken = settingSecret('ngrok_authtoken', ['NGROK_AUTHTOKEN']);
    const rowDomain = db.prepare("SELECT value FROM app_settings WHERE key='ngrok_domain'").get();
    
    if (!authtoken) {
      return res.status(400).json({ error: 'Ngrok Auth Token is not configured in settings or NGROK_AUTHTOKEN' });
    }

    assertCanExposePublicly();
    
    const url = await ngrokService.startTunnel({
      authtoken,
      domain: rowDomain?.value || null,
      port: process.env.PORT || 3001
    });
    
    res.json({ success: true, url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/ngrok/stop', async (req, res) => {
  await ngrokService.stopTunnel();
  res.json({ success: true });
});

router.get('/ngrok/status', (req, res) => {
  const url = ngrokService.getTunnelUrl();
  res.json({ running: !!url, url });
});

module.exports = router;
