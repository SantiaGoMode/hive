const express = require('express');
const router  = express.Router();
const db      = require('../db');
const ngrokService = require('../lib/ngrokService');
const { getSystemMemory } = require('../lib/systemMemory');
const { getOllamaUrl, ollamaApiUrl } = require('../lib/ollamaUrl');
const { settingSecret } = require('../lib/secrets');

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
  } catch {}

  res.json({
    memory,
    models,
    ollama_reachable: ollamaReachable,
    ollama_url: ollamaUrl,
  });
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
