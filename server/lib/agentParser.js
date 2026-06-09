const fs   = require('fs');
const path = require('path');
const os   = require('os');
const db   = require('../db');

const DASH_DIR = process.env.HIVE_HOME || path.join(os.homedir(), '.hive');

function agentWorkspace(id) {
  return path.join(DASH_DIR, 'agents', id);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Strip "ollama/" provider prefix for Ollama API calls
function stripProviderPrefix(model) {
  return (model || '').replace(/^ollama\//, '');
}

function rowToAgent(row) {
  return {
    id:             row.id,
    name:           row.name,
    persona_name:   row.persona_name || '',
    persona_role:   row.persona_role || '',
    model:          row.model || '',
    description:    row.description || '',
    avatar_color:   row.avatar_color || '#3b82f6',
    temperature:    row.temperature ?? 0.7,
    max_tokens:     row.max_tokens ?? 4096,
    context_length: row.context_length ?? 8192,
    tools:          JSON.parse(row.tools || '[]'),
    system_prompt:  row.system_prompt || '',
    workspace:      row.workspace || agentWorkspace(row.id),
    ephemeral:      !!row.ephemeral,
    gateway_budget_usd: row.gateway_budget_usd ?? null,
    gateway_key:    row.gateway_key || '',
    last_active:    row.last_active ? new Date(row.last_active * 1000).toISOString() : null,
  };
}

// By default, ephemeral colony-owned agents are hidden from the main Agents list.
// Pass { includeEphemeral: true } to include them.
function listAgents({ includeEphemeral = false } = {}) {
  const where = includeEphemeral ? '' : 'WHERE ephemeral = 0 OR ephemeral IS NULL';
  return db.prepare(`SELECT * FROM agents ${where} ORDER BY updated_at DESC`).all().map(rowToAgent);
}

function readAgent(id) {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  return row ? rowToAgent(row) : null;
}

function writeAgent(id, data) {
  if (!id) {
    // ── Create ────────────────────────────────────────────────────────────────
    const newId_ = newId();
    const workspace = agentWorkspace(newId_);
    fs.mkdirSync(path.join(workspace, 'sessions'), { recursive: true });

    db.prepare(`
      INSERT INTO agents (id, name, persona_name, persona_role, model, description, avatar_color, temperature, max_tokens, context_length, tools, system_prompt, workspace, ephemeral, gateway_budget_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newId_,
      data.name || 'Agent',
      data.persona_name || '',
      data.persona_role || '',
      data.model || '',
      data.description || '',
      data.avatar_color || '#3b82f6',
      data.temperature ?? 0.7,
      data.max_tokens ?? 4096,
      data.context_length ?? 8192,
      JSON.stringify(data.tools || []),
      data.system_prompt || '',
      workspace,
      data.ephemeral ? 1 : 0,
      (data.gateway_budget_usd != null && data.gateway_budget_usd !== '') ? Number(data.gateway_budget_usd) : null,
    );

    return readAgent(newId_);

  } else {
    // ── Update ────────────────────────────────────────────────────────────────
    const existing = readAgent(id);
    if (!existing) throw new Error(`Agent ${id} not found`);

    // Resolve the new budget; if it changed, drop the minted key so it re-mints
    // with the new cap on next use.
    const newBudget = (data.gateway_budget_usd === undefined)
      ? existing.gateway_budget_usd
      : ((data.gateway_budget_usd === null || data.gateway_budget_usd === '') ? null : Number(data.gateway_budget_usd));
    const budgetChanged = Number(newBudget || 0) !== Number(existing.gateway_budget_usd || 0);
    const nextKey = budgetChanged ? '' : (existing.gateway_key || '');

    db.prepare(`
      UPDATE agents
      SET name=?, persona_name=?, persona_role=?, model=?, description=?, avatar_color=?,
          temperature=?, max_tokens=?, context_length=?, tools=?, system_prompt=?,
          gateway_budget_usd=?, gateway_key=?, updated_at=unixepoch()
      WHERE id=?
    `).run(
      data.name           ?? existing.name,
      data.persona_name   ?? existing.persona_name,
      data.persona_role   ?? existing.persona_role,
      data.model          ?? existing.model,
      data.description    ?? existing.description,
      data.avatar_color   ?? existing.avatar_color,
      data.temperature    ?? existing.temperature,
      data.max_tokens     ?? existing.max_tokens,
      data.context_length ?? existing.context_length,
      JSON.stringify(data.tools ?? existing.tools),
      data.system_prompt  ?? existing.system_prompt,
      newBudget,
      nextKey,
      id,
    );

    return readAgent(id);
  }
}

function deleteAgent(id) {
  const agent = readAgent(id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  // Only remove workspace if it's inside our own dash directory (don't delete migrated legacy workspaces)
  if (agent?.workspace?.startsWith(DASH_DIR)) {
    try { fs.rmSync(agent.workspace, { recursive: true, force: true }); } catch {}
  }
}

function touchAgent(id) {
  db.prepare('UPDATE agents SET last_active=unixepoch() WHERE id=?').run(id);
}

module.exports = { listAgents, readAgent, writeAgent, deleteAgent, touchAgent, stripProviderPrefix };
