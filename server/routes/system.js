const express = require('express');
const router  = express.Router();
const os      = require('os');
const db      = require('../db');

function getOllamaUrl() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='ollama_url'").get();
  return row?.value || 'http://localhost:11434';
}

// GET /api/system/status — RAM + running Ollama models
router.get('/status', async (req, res) => {
  const total  = os.totalmem();
  const free   = os.freemem();

  let models = [];
  let ollamaReachable = false;
  const ollamaUrl = getOllamaUrl();

  try {
    const r = await fetch(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const data = await r.json();
      models = data.models || [];
      ollamaReachable = true;
    }
  } catch {}

  res.json({
    memory: { total, free, used: total - free },
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

module.exports = router;
