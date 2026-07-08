const express = require('express');
const router = express.Router();
const db = require('../db');
const { v4 } = require('../lib/uuid');
const mcpManager = require('../lib/mcpClient');
const { builtInToolCatalog } = require('../lib/agentTools');
const { logSwallowed } = require('../lib/logSwallowed');

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
  try { templates = JSON.parse(row.templates || '[]'); } catch (e) { logSwallowed('skillsRoutes:parseTemplates', e, { id: row.id }); }
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

// Labels/descriptions for the registry groups. The group list itself comes
// from builtInToolCatalog() so new tool modules can never silently drift out
// of this endpoint again (that's how the `github` group went missing).
const GROUP_META = {
  sandbox: { label: 'Sandbox', description: 'File workspace, run Python/Bash, write files' },
  web_search: { label: 'Web Search', description: 'Built-in Ollama web search/fetch; requires ollama signin' },
  memory: { label: 'Memory', description: 'Persist notes and recall across sessions' },
  protocol: { label: 'Protocol', description: 'Colony blackboard, handoffs, and coordination' },
  colony_tools: { label: 'Colony Tools', description: 'Colony management tools (operator-level)' },
  agent_tools: { label: 'Agent Tools', description: 'Delegate to and ask other agents' },
  github: { label: 'GitHub', description: 'Issues, PRs, comments, and repo reads via the GitHub API' },
  skills: { label: 'Skill Loader', description: 'Browse the skill catalog and load skills mid-conversation' },
  hive_admin: { label: 'Hive Admin', description: 'Read/modify staff profiles, skills, tool grants, and non-secret settings' },
  media: { label: 'Media Generation', description: 'Local text-to-image (FLUX.2-klein) and text-to-speech (Orpheus), both via Ollama' },
};

// Worker-internal groups that only make sense when the runtime injects them.
const INTERNAL_GROUPS = new Set(['delegation', 'protocol_worker', 'sandbox_files', 'colony_operator']);

router.get('/tool-options', (req, res) => {
  const catalog = builtInToolCatalog();
  const builtin = Object.keys(catalog)
    .filter(group => !INTERNAL_GROUPS.has(group))
    .sort((a, b) => (GROUP_META[a] ? 0 : 1) - (GROUP_META[b] ? 0 : 1) || a.localeCompare(b))
    .map(group => {
      const functions = catalog[group];
      const meta = GROUP_META[group] || { label: group, description: '' };
      return {
        value: group,
        ...meta,
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
