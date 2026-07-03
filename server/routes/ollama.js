const express = require('express');
const router = express.Router();
const { ollamaApiUrl } = require('../lib/ollamaUrl');

router.get('/models', async (req, res) => {
  try {
    const r = await fetch(ollamaApiUrl('tags'));
    const data = await r.json();
    const models = data.models || [];
    // Annotate with capabilities (tools/thinking/vision/…) via cached /api/show
    // probes so the UI can say which models can actually drive agents.
    const { getCapabilities } = require('../lib/providers/ollamaCapabilities');
    const base = ollamaApiUrl('tags').replace(/\/api\/tags$/, '');
    const annotated = await Promise.all(models.map(async m => ({
      ...m,
      capabilities: await getCapabilities(m.name, base),
    })));
    res.json(annotated);
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
    const r = await fetch(ollamaApiUrl('pull'), {
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
    const r = await fetch(ollamaApiUrl('delete'), {
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
    const r = await fetch(ollamaApiUrl('show'), {
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

module.exports = router;
