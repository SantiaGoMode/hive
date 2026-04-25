const express = require('express');
const router = express.Router();
const db = require('../db');

function getOllamaUrl() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'ollama_url'").get();
  return row ? row.value : 'http://localhost:11434';
}

async function checkOllamaStatus() {
  const url = getOllamaUrl();
  try {
    const r = await fetch(`${url}/api/tags`);
    if (!r.ok) {
      return {
        reachable: false,
        url,
        status: r.status,
        error: `Ollama responded with ${r.status}`,
      };
    }
    const data = await r.json();
    return {
      reachable: true,
      url,
      models: data.models || [],
    };
  } catch (e) {
    return {
      reachable: false,
      url,
      error: e.message,
    };
  }
}

router.get('/status', async (req, res) => {
  res.json(await checkOllamaStatus());
});

router.get('/models', async (req, res) => {
  try {
    const r = await fetch(`${getOllamaUrl()}/api/tags`);
    const data = await r.json();
    res.json(data.models || []);
  } catch (e) {
    res.status(503).json({ error: 'Ollama not reachable', detail: e.message });
  }
});

router.post('/pull', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const r = await fetch(`${getOllamaUrl()}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    });

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.trim()) res.write(`data: ${line}\n\n`);
      }
    }
    res.write('data: {"status":"done"}\n\n');
  } catch (e) {
    res.write(`data: {"error":"${e.message}"}\n\n`);
  }
  res.end();
});

router.delete('/models/:name', async (req, res) => {
  try {
    const r = await fetch(`${getOllamaUrl()}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: req.params.name }),
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to delete model' });
    res.json({ success: true });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

router.get('/models/:name/info', async (req, res) => {
  try {
    const r = await fetch(`${getOllamaUrl()}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: req.params.name }),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

router.checkOllamaStatus = checkOllamaStatus;

module.exports = router;
