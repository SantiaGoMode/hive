// ── Colony teams ──────────────────────────────────────────────────────────────
// A Colony is a named, persistent team (name + description + repo/project +
// recipe + base config). Runs are rows in the legacy `colonies` table linked
// via team_id. This module owns team CRUD plus the aggregated overview the
// colony page renders: crew, performance, runs, and artifacts across runs.

const db = require('../db');
const { DEFAULT_RECIPE_ID, getColonyRecipe } = require('./colonyRecipes');
const staffDirectory = require('./staffDirectory');
const { logSwallowed } = require('./logSwallowed');

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function safeParse(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function rowToTeam(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    recipe_id: row.recipe_id || DEFAULT_RECIPE_ID,
    repo_path: row.repo_path || null,
    cloud_enabled: !!row.cloud_enabled,
    github_writeback: !!row.github_writeback,
    memory: row.memory || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function runStatsForTeam(teamId) {
  const rows = db.prepare(
    'SELECT status, created_at, updated_at FROM colonies WHERE team_id=?',
  ).all(teamId);
  const byStatus = {};
  let durationSum = 0;
  let durationCount = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (['done', 'stopped', 'error'].includes(r.status) && r.updated_at >= r.created_at) {
      durationSum += r.updated_at - r.created_at;
      durationCount++;
    }
  }
  const finished = (byStatus.done || 0) + (byStatus.stopped || 0) + (byStatus.error || 0);
  return {
    total_runs: rows.length,
    by_status: byStatus,
    success_rate: finished ? (byStatus.done || 0) / finished : null,
    avg_duration_secs: durationCount ? Math.round(durationSum / durationCount) : null,
  };
}

function createTeam({ name, description = '', recipeId = DEFAULT_RECIPE_ID, repoPath = null, cloudEnabled = false, githubWriteback = false } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Colony name is required');
  if (getColonyRecipe(recipeId).id !== recipeId) throw new Error('unknown recipe_id');
  const id = newId();
  db.prepare(
    'INSERT INTO colony_teams (id, name, description, recipe_id, repo_path, cloud_enabled, github_writeback) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, trimmed, String(description || '').trim(), recipeId, repoPath || null, cloudEnabled ? 1 : 0, githubWriteback ? 1 : 0);
  return getTeam(id);
}

function getTeam(id) {
  return rowToTeam(db.prepare('SELECT * FROM colony_teams WHERE id=?').get(id));
}

function listTeams() {
  return db.prepare('SELECT * FROM colony_teams ORDER BY created_at ASC').all().map(row => {
    const team = rowToTeam(row);
    const stats = runStatsForTeam(team.id);
    const last = db.prepare(
      'SELECT id, status, goal, created_at FROM colonies WHERE team_id=? ORDER BY created_at DESC LIMIT 1',
    ).get(team.id);
    return { ...team, stats, last_run: last || null };
  });
}

function updateTeam(id, data = {}) {
  const existing = getTeam(id);
  if (!existing) return null;
  const patch = {};
  if (data.name !== undefined) {
    const v = String(data.name || '').trim();
    if (!v) throw new Error('Colony name is required');
    patch.name = v;
  }
  if (data.description !== undefined) patch.description = String(data.description || '').trim();
  if (data.recipe_id !== undefined) {
    if (getColonyRecipe(data.recipe_id).id !== data.recipe_id) throw new Error('unknown recipe_id');
    patch.recipe_id = data.recipe_id;
  }
  if (data.repo_path !== undefined) patch.repo_path = String(data.repo_path || '').trim() || null;
  if (data.memory !== undefined) patch.memory = String(data.memory || '');
  if (data.cloud_enabled !== undefined) patch.cloud_enabled = data.cloud_enabled ? 1 : 0;
  if (data.github_writeback !== undefined) patch.github_writeback = data.github_writeback ? 1 : 0;
  const keys = Object.keys(patch);
  if (!keys.length) return existing;
  db.prepare(`UPDATE colony_teams SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=unixepoch() WHERE id=?`)
    .run(...keys.map(k => patch[k]), id);
  return getTeam(id);
}

// Deleting a team deletes its runs too (and their agents/protocol rows) —
// the runs have no meaning outside their colony.
function deleteTeam(id) {
  const { deleteColony } = require('./colonyRunner');
  const runs = db.prepare('SELECT id FROM colonies WHERE team_id=?').all(id);
  for (const r of runs) {
    try { deleteColony(r.id); } catch (e) { logSwallowed('colonyTeams:deleteRun', e, { colonyId: r.id }); }
  }
  db.prepare('DELETE FROM colony_teams WHERE id=?').run(id);
}

// Full overview for the colony page: team config, crew (staff profiles for the
// recipe), performance stats, run list, and artifacts aggregated from every
// run's deliverable.
function teamOverview(id) {
  const team = getTeam(id);
  if (!team) return null;

  const runs = db.prepare(`
    SELECT id, goal, model, recipe_id, status, summary, created_at, updated_at, board_card, trigger, deliverable
    FROM colonies WHERE team_id=? ORDER BY created_at DESC
  `).all(id).map(r => ({
    id: r.id,
    goal: r.goal,
    model: r.model,
    recipe_id: r.recipe_id,
    status: r.status,
    summary: r.summary || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    board_card: safeParse(r.board_card, null),
    trigger: safeParse(r.trigger, null),
    has_deliverable: !!r.deliverable,
  }));

  const artifacts = [];
  const insights = [];
  for (const r of db.prepare('SELECT id, goal, created_at, deliverable FROM colonies WHERE team_id=? ORDER BY created_at DESC').all(id)) {
    const d = safeParse(r.deliverable, null);
    if (!d) continue;
    const links = Array.isArray(d.links) ? d.links : [];
    const files = Array.isArray(d.artifacts) ? d.artifacts : [];
    if (links.length || files.length) {
      artifacts.push({ run_id: r.id, goal: r.goal, created_at: r.created_at, links, files });
    }
    // Cross-run insights: operator improvement reports + failed acceptance
    // criteria. This is the view the run page can't give you — patterns
    // across the colony's whole history.
    for (const w of (Array.isArray(d.workarounds) ? d.workarounds : [])) {
      insights.push({
        type: 'workaround',
        run_id: r.id, goal: r.goal, created_at: r.created_at,
        issue: w.issue || '', workaround: w.workaround || '',
        recommendation: w.recommendation || '', impact: w.impact || '',
      });
    }
    for (const res of (d.acceptance?.results || [])) {
      if (res.status !== 'fail') continue;
      insights.push({
        type: 'acceptance_fail',
        run_id: r.id, goal: r.goal, created_at: r.created_at,
        issue: res.criterion || '', recommendation: res.evidence || '',
      });
    }
  }
  // Open blockers from recent runs round out the picture.
  try {
    const blockerRows = db.prepare(`
      SELECT b.colony_id, b.agent, b.content, b.created_at, c.goal
      FROM colony_blackboard b JOIN colonies c ON c.id=b.colony_id
      WHERE c.team_id=? AND b.entry_type='blocker'
      ORDER BY b.id DESC LIMIT 10
    `).all(id);
    for (const b of blockerRows) {
      insights.push({
        type: 'blocker',
        run_id: b.colony_id, goal: b.goal, created_at: b.created_at,
        issue: String(b.content || '').slice(0, 400), agent: b.agent || '',
      });
    }
  } catch (e) { logSwallowed('colonyTeams:blockerInsights', e, { teamId: id }); }
  insights.sort((a, b) => b.created_at - a.created_at);
  insights.length = Math.min(insights.length, 30);

  let crew = [];
  try {
    crew = staffDirectory.listProfiles()
      .filter(p => p.recipe_id === team.recipe_id)
      .map(p => ({
        id: p.id,
        role_key: p.role_key,
        display_name: p.display_name,
        role: p.role,
        avatar_color: p.avatar_color,
        skills: p.skills,
        model_preference: p.model_preference || '',
      }));
  } catch (e) { logSwallowed('colonyTeams:crew', e, { teamId: id }); }

  return { team, runs, artifacts, insights, crew, performance: runStatsForTeam(id) };
}

// Append an operator memory update for a finished run, keeping the memory
// bounded: when it outgrows MEMORY_MAX_CHARS, oldest run sections are dropped
// from the top (the leading free-form/user-edited block is preserved).
const MEMORY_MAX_CHARS = 12000;

function appendTeamMemory(teamId, sectionTitle, bullets) {
  const team = getTeam(teamId);
  if (!team || !Array.isArray(bullets) || !bullets.length) return null;
  const section = `### ${sectionTitle}\n${bullets.map(b => `- ${b}`).join('\n')}`;
  let memory = team.memory ? `${team.memory.trimEnd()}\n\n${section}` : section;
  while (memory.length > MEMORY_MAX_CHARS) {
    // Oldest dated section = the first "### " header (sections append in
    // chronological order). Everything before it is the user-edited preamble.
    const first = memory.startsWith('### ') ? 0 : memory.indexOf('\n### ');
    if (first === -1) { memory = memory.slice(-MEMORY_MAX_CHARS); break; }
    const next = memory.indexOf('\n### ', first + 1);
    if (next === -1) { memory = memory.slice(-MEMORY_MAX_CHARS); break; }
    memory = `${memory.slice(0, first).trimEnd()}\n${memory.slice(next + 1)}`.trimStart();
  }
  db.prepare('UPDATE colony_teams SET memory=?, updated_at=unixepoch() WHERE id=?').run(memory, teamId);
  return memory;
}

module.exports = {
  createTeam,
  getTeam,
  listTeams,
  updateTeam,
  deleteTeam,
  teamOverview,
  runStatsForTeam,
  appendTeamMemory,
};
