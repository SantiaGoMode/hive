const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { listAgents, readAgent, writeAgent, deleteAgent } = require('../lib/agentParser');
const activity = require('../lib/activityTracker');

router.get('/', (req, res) => {
  res.json(listAgents());
});

// SSE stream: sends {agentId, status:'streaming'|'idle'} events.
// On connect, immediately sends current active set so client is in sync.
router.get('/activity', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately
  for (const agentId of activity.getActive()) {
    res.write(`data: ${JSON.stringify({ agentId, status: 'streaming' })}\n\n`);
  }

  activity.addListener(res);
  req.on('close', () => activity.removeListener(res));
});

router.get('/:id', (req, res) => {
  const agent = readAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

router.post('/', (req, res) => {
  const { name, ...rest } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const agent = writeAgent(null, { name, ...rest });
    res.status(201).json(agent);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', (req, res) => {
  const existing = readAgent(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agent not found' });
  try {
    const agent = writeAgent(req.params.id, { ...existing, ...req.body });
    res.json(agent);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  const existing = readAgent(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agent not found' });
  try {
    deleteAgent(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Memory (MEMORY.md) ────────────────────────────────────────────────────────
router.get('/:id/memory', (req, res) => {
  const agent = readAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const memPath = path.join(agent.workspace, 'MEMORY.md');
  const content = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf8') : '';
  res.json({ content });
});

router.put('/:id/memory', (req, res) => {
  const agent = readAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content is required' });
  const memPath = path.join(agent.workspace, 'MEMORY.md');
  fs.mkdirSync(path.dirname(memPath), { recursive: true });
  fs.writeFileSync(memPath, content, 'utf8');
  res.json({ success: true });
});

router.delete('/:id/memory', (req, res) => {
  const agent = readAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const memPath = path.join(agent.workspace, 'MEMORY.md');
  if (fs.existsSync(memPath)) fs.unlinkSync(memPath);
  res.json({ success: true });
});

module.exports = router;
