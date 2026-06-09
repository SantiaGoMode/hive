const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const mcpManager = require('../lib/mcpClient');

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function isMasked(value) {
  return typeof value === 'string' && value.includes('•');
}

function mergeMaskedEnv(nextEnv, existingEnv) {
  const next = nextEnv || {};
  const existing = existingEnv || {};
  const out = {};
  for (const [key, value] of Object.entries(next)) {
    out[key] = isMasked(value) && Object.prototype.hasOwnProperty.call(existing, key)
      ? existing[key]
      : value;
  }
  return out;
}

// List all servers with live status
router.get('/', (req, res) => {
  res.json(mcpManager.getStatus());
});

// Create
router.post('/', async (req, res) => {
  const { name, transport = 'stdio', command, args = [], env = {}, env_secret_keys = [], url, enabled = true } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (transport === 'stdio' && !command?.trim()) return res.status(400).json({ error: 'command is required for stdio transport' });
  if (transport === 'http'  && !url?.trim())     return res.status(400).json({ error: 'url is required for http transport' });

  const id = newId();
  db.prepare(
    'INSERT INTO mcp_servers (id, name, transport, command, args, env, env_secret_keys, url, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name.trim(), transport, command?.trim() || null, JSON.stringify(args), JSON.stringify(env), JSON.stringify(env_secret_keys), url?.trim() || null, enabled ? 1 : 0);

  if (enabled) {
    try { await mcpManager.reconnect(id); } catch (e) {
      console.warn(`[mcp] Auto-connect after create failed for "${name}": ${e.message}`);
    }
  }

  res.status(201).json(mcpManager.getStatus().find(s => s.id === id));
});

// Update
router.put('/:id', async (req, res) => {
  const existing = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Server not found' });

  const { name, transport, command, args, env, env_secret_keys, url, enabled } = req.body;
  const existingEnv = JSON.parse(existing.env || '{}');
  const storedEnv = env != null ? mergeMaskedEnv(env, existingEnv) : existingEnv;
  db.prepare(
    'UPDATE mcp_servers SET name=?, transport=?, command=?, args=?, env=?, env_secret_keys=?, url=?, enabled=? WHERE id=?',
  ).run(
    name             ?? existing.name,
    transport        ?? existing.transport,
    command          ?? existing.command,
    args             != null ? JSON.stringify(args)             : existing.args,
    env              != null ? JSON.stringify(storedEnv)        : existing.env,
    env_secret_keys  != null ? JSON.stringify(env_secret_keys)  : (existing.env_secret_keys || '[]'),
    url              ?? existing.url,
    enabled          != null ? (enabled ? 1 : 0) : existing.enabled,
    req.params.id,
  );

  try { await mcpManager.reconnect(req.params.id); } catch (e) {
    console.warn(`[mcp] Reconnect after update failed: ${e.message}`);
  }

  res.json(mcpManager.getStatus().find(s => s.id === req.params.id));
});

// Delete
router.delete('/:id', (req, res) => {
  mcpManager.disconnect(req.params.id);
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Test a server config without saving
router.post('/test', async (req, res) => {
  try {
    const result = await mcpManager.test(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Manually reconnect a disconnected server
router.post('/:id/reconnect', async (req, res) => {
  try {
    await mcpManager.reconnect(req.params.id);
    res.json(mcpManager.getStatus().find(s => s.id === req.params.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
