const express = require('express');
const router = express.Router();
const db = require('../db');
const { v4 } = require('../lib/uuid');
const mcpManager = require('../lib/mcpClient');
const { builtInToolCatalog } = require('../lib/agentTools');

const TEMPLATE_TYPES = ['code', 'table', 'instructions', 'text'];

function normalizeTemplates(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(t => ({
      title: String(t?.title || '').trim(),
      type: TEMPLATE_TYPES.includes(t?.type) ? t.type : 'text',
      content: String(t?.content || ''),
    }))
    .filter(t => t.title || t.content.trim());
}

function rowToJson(row) {
  if (!row) return null;
  let templates = [];
  try { templates = JSON.parse(row.templates || '[]'); } catch {}
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    instructions: row.instructions || '',
    templates: Array.isArray(templates) ? templates : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Skills catalog (user-managed) ─────────────────────────────────────────────

router.get('/', (req, res) => {
  const skills = db.prepare('SELECT * FROM skills ORDER BY name COLLATE NOCASE').all().map(rowToJson);
  res.json({ skills });
});

router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const description = String(req.body?.description || '').trim();
  const instructions = String(req.body?.instructions || '');
  const templates = JSON.stringify(normalizeTemplates(req.body?.templates));
  const id = v4();
  try {
    db.prepare('INSERT INTO skills (id, name, description, instructions, templates) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, description, instructions, templates);
  } catch (e) {
    return res.status(409).json({ error: `A skill named "${name}" already exists` });
  }
  res.status(201).json(rowToJson(db.prepare('SELECT * FROM skills WHERE id=?').get(id)));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM skills WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Skill not found' });
  const name = req.body?.name != null ? String(req.body.name).trim() : existing.name;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const description = req.body?.description != null ? String(req.body.description).trim() : existing.description;
  const instructions = req.body?.instructions != null ? String(req.body.instructions) : existing.instructions;
  const templates = req.body?.templates != null
    ? JSON.stringify(normalizeTemplates(req.body.templates))
    : (existing.templates || '[]');
  try {
    db.prepare('UPDATE skills SET name=?, description=?, instructions=?, templates=?, updated_at=unixepoch() WHERE id=?')
      .run(name, description, instructions, templates, req.params.id);
  } catch (e) {
    return res.status(409).json({ error: `A skill named "${name}" already exists` });
  }
  // Propagate renames into staff profiles so assignments stay consistent.
  if (name !== existing.name) {
    const profiles = db.prepare('SELECT id, skills FROM staff_profiles').all();
    for (const p of profiles) {
      let skills;
      try { skills = JSON.parse(p.skills || '[]'); } catch { continue; }
      if (!Array.isArray(skills) || !skills.includes(existing.name)) continue;
      const next = skills.map(s => (s === existing.name ? name : s));
      db.prepare('UPDATE staff_profiles SET skills=?, updated_at=unixepoch() WHERE id=?')
        .run(JSON.stringify(next), p.id);
    }
  }
  res.json(rowToJson(db.prepare('SELECT * FROM skills WHERE id=?').get(req.params.id)));
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM skills WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Skill not found' });
  db.prepare('DELETE FROM skills WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Tool options (built-in groups + connected MCP servers) ────────────────────
// Used to populate the tools picker on the Staff page and the Skills & Tools page.
// Built-in entries include the individual functions each group exposes, in the
// same shape MCP servers report (tool_names + per-function detail).

const BUILT_IN_TOOLS = [
  { value: 'sandbox', label: 'Sandbox', description: 'File workspace, run Python/Bash, write files' },
  { value: 'web_search', label: 'Web Search', description: 'Search the web and fetch pages' },
  { value: 'memory', label: 'Memory', description: 'Persist notes and recall across sessions' },
  { value: 'protocol', label: 'Protocol', description: 'Colony blackboard, handoffs, and coordination' },
  { value: 'colony_tools', label: 'Colony Tools', description: 'Colony management tools (operator-level)' },
  { value: 'agent_tools', label: 'Agent Tools', description: 'Delegate to and ask other agents' },
];

router.get('/tool-options', (req, res) => {
  const catalog = builtInToolCatalog();
  const builtin = BUILT_IN_TOOLS.map(t => {
    const functions = catalog[t.value] || [];
    return {
      ...t,
      kind: 'builtin',
      connected: true,
      tool_names: functions.map(f => f.name),
      functions,
    };
  });
  const mcp = mcpManager.getStatus().map(s => ({
    value: `mcp:${s.id}`,
    label: s.name,
    description: s.connected
      ? `MCP server — ${s.tool_count} tool${s.tool_count === 1 ? '' : 's'}`
      : 'MCP server — not connected',
    kind: 'mcp',
    connected: s.connected,
    tool_names: s.tool_names,
    functions: s.tool_names.map(name => ({ name, description: '' })),
  }));
  res.json({ tools: [...builtin, ...mcp] });
});

module.exports = router;
