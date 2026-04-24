const express = require('express');
const router = express.Router();
const { listSessions, getSession, deleteSession, searchSessions } = require('../lib/sessionReader');
const db = require('../db');

router.get('/search', (req, res) => {
  const { q, agent_id } = req.query;
  if (!q) return res.json([]);
  res.json(searchSessions(q, agent_id));
});

router.get('/:agentId', (req, res) => {
  res.json(listSessions(req.params.agentId));
});

router.get('/:agentId/:sessId', (req, res) => {
  const session = getSession(req.params.agentId, req.params.sessId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

router.patch('/:agentId/:sessId', (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  db.prepare('INSERT OR REPLACE INTO sessions_meta (agent_id, session_id, title) VALUES (?, ?, ?)')
    .run(req.params.agentId, req.params.sessId, title.trim());
  res.json({ success: true });
});

router.delete('/:agentId/:sessId', (req, res) => {
  deleteSession(req.params.agentId, req.params.sessId);
  db.prepare('DELETE FROM sessions_meta WHERE agent_id = ? AND session_id = ?')
    .run(req.params.agentId, req.params.sessId);
  res.json({ success: true });
});

module.exports = router;
