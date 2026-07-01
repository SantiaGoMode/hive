// Empty-board bootstrap helpers: locate source docs (PRD/SPEC/README) in a
// connected repo and parse a Project Manager's drafted task list.
const fs = require('fs');
const path = require('path');
const { logSwallowed } = require('../logSwallowed');
const protocol = require('../colonyProtocol');
const { readAgent } = require('../agentParser');
const db = require('../../db');

const BOOTSTRAP_DOC_CANDIDATES = [
  'docs/PRD.md',
  'docs/prd.md',
  'PRD.md',
  'SPEC.md',
  'README.md',
  'readme.md',
];

function readBootstrapSource(repoPath) {
  if (!repoPath) return null;
  for (const rel of BOOTSTRAP_DOC_CANDIDATES) {
    const p = path.join(repoPath, rel);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return { path: rel, content: fs.readFileSync(p, 'utf8').slice(0, 20000) };
      }
    } catch (e) { logSwallowed('colonyRunner:bootstrapSource', e); }
  }
  try {
    const docsDir = path.join(repoPath, 'docs');
    if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
      const md = fs.readdirSync(docsDir).find(name => /\.md$/i.test(name));
      if (md) {
        const rel = path.join('docs', md);
        return { path: rel, content: fs.readFileSync(path.join(repoPath, rel), 'utf8').slice(0, 20000) };
      }
    }
  } catch (e) { logSwallowed('colonyRunner:bootstrapSource', e); }
  return null;
}

function parseBootstrapTasks(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const jsonMatch = raw.match(/```json\s*([\s\S]+?)```/i) || raw.match(/(\[[\s\S]+\])/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) return parsed.map(normalizeBootstrapTask).filter(Boolean);
      if (Array.isArray(parsed.tasks)) return parsed.tasks.map(normalizeBootstrapTask).filter(Boolean);
    } catch {} /* model may not emit valid JSON; falls back to line parsing below */
  }
  return raw.split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s+|\d+[.)]\s+/.test(line))
    .slice(0, 12)
    .map((line, i) => normalizeBootstrapTask({
      id: `T${i + 1}`,
      title: line.replace(/^[-*]\s+|\d+[.)]\s+/, '').slice(0, 120),
      description: line.replace(/^[-*]\s+|\d+[.)]\s+/, ''),
      acceptance_criteria: [],
      suggested_order: i + 1,
    }))
    .filter(Boolean);
}

function normalizeBootstrapTask(task, idx = 0) {
  if (!task || typeof task !== 'object') return null;
  const title = String(task.title || task.name || '').trim();
  if (!title) return null;
  const criteria = Array.isArray(task.acceptance_criteria)
    ? task.acceptance_criteria.map(v => String(v).trim()).filter(Boolean)
    : (task.acceptance_criteria ? [String(task.acceptance_criteria)] : []);
  return {
    id: String(task.id || `T${idx + 1}`),
    title,
    description: String(task.description || task.details || '').trim(),
    acceptance_criteria: criteria,
    suggested_order: Number(task.suggested_order || task.order || idx + 1),
  };
}

// Empty-board bootstrap flow: if a connected repo has no GitHub issue/project
// cards, ask the PM to draft a reviewable task list from source docs and stop
// before implementation. A human must accept the tasks before they become the
// colony plan. Returns true when the run should stop early (awaiting tasks).
// `ctx` = { colonyId, row, recipe, recipeWorkers, ollamaUrl, signal,
//           reasoningByAgentId, workerReasoningDefault,
//           fetchRepoBoard, runAgentOnce, addEntry, onEvent, flush }
async function maybeRunBootstrap(ctx) {
  const {
    colonyId, row, recipe, recipeWorkers, ollamaUrl, signal,
    reasoningByAgentId, workerReasoningDefault,
    fetchRepoBoard, runAgentOnce, addEntry, onEvent, flush,
  } = ctx;

  if (!(row.repo_path && recipe.id === 'development_team' && !row.bootstrap_accepted && !row.bootstrap_tasks)) {
    return false;
  }

  let board = null;
  try { board = await fetchRepoBoard({ cwd: row.repo_path }); } catch (e) { logSwallowed('colonyRunner:fetchBoard', e, { colonyId }); }
  if (!(board && !board.auth_required && Array.isArray(board.cards) && board.cards.length === 0)) {
    return false;
  }

  const source = readBootstrapSource(row.repo_path);
  if (!source?.content) {
    const msg = 'No board items were found, but no README/PRD/SPEC source material was available for bootstrap task drafting.';
    protocol.writeBlackboard(colonyId, 'operator', 'blocker', msg, { bootstrap: true });
    db.prepare("UPDATE colonies SET status='awaiting_tasks', updated_at=unixepoch() WHERE id=?").run(colonyId);
    addEntry({ kind: 'bootstrap', status: 'blocked', message: msg });
    flush();
    onEvent({ type: 'done', status: 'awaiting_tasks' });
    return true;
  }

  const pmWorker = recipeWorkers.find(w => w.role_key === 'project_manager');
  const pmAgent = pmWorker ? readAgent(pmWorker.id) : null;
  if (pmAgent) {
    const bootstrapRoleByAgentId = new Map(recipeWorkers.filter(w => w.role_key).map(w => [w.id, w.role_key]));
    addEntry({ kind: 'bootstrap', status: 'drafting', source: source.path, message: `No board items found. Asking Project Manager to draft tasks from ${source.path}.` });
    const bootstrapPrompt = [
      'The connected repo has no issue/project board items. Do NOT start implementation.',
      `Source file: ${source.path}`,
      'Draft a concrete, ordered task list from the source material.',
      'Return JSON only in this shape: [{"id":"T1","title":"...","description":"...","acceptance_criteria":["..."],"suggested_order":1}]',
      '',
      'Source material:',
      source.content,
    ].join('\n');
    const response = await runAgentOnce(pmAgent, [{ role: 'user', content: bootstrapPrompt }], ollamaUrl, 0, null, null, null, 8, signal, {
      colonyId,
      recipeId: recipe.id,
      roleByAgentId: bootstrapRoleByAgentId,
      agentHistories: new Map(),
      reasoningByAgentId,
      workerReasoningDefault,
    });
    const tasks = parseBootstrapTasks(response);
    if (tasks.length > 0) {
      db.prepare("UPDATE colonies SET status='awaiting_tasks', bootstrap_tasks=?, updated_at=unixepoch() WHERE id=?")
        .run(JSON.stringify(tasks), colonyId);
      protocol.writeBlackboard(colonyId, 'Project Manager', 'state',
        `Bootstrap task draft from ${source.path}:\n${tasks.map(t => `- ${t.id}. ${t.title}`).join('\n')}`,
        { bootstrap: true, source: source.path, tasks });
      addEntry({ kind: 'bootstrap', status: 'awaiting_acceptance', source: source.path, task_count: tasks.length, tasks });
      flush();
      onEvent({ type: 'done', status: 'awaiting_tasks' });
      return true;
    }
  }

  const msg = `No board items were found, but the Project Manager did not return a usable task list from ${source.path}.`;
  protocol.writeBlackboard(colonyId, 'operator', 'blocker', msg, { bootstrap: true, source: source.path });
  db.prepare("UPDATE colonies SET status='awaiting_tasks', updated_at=unixepoch() WHERE id=?").run(colonyId);
  addEntry({ kind: 'bootstrap', status: 'blocked', source: source.path, message: msg });
  flush();
  onEvent({ type: 'done', status: 'awaiting_tasks' });
  return true;
}

module.exports = {
  BOOTSTRAP_DOC_CANDIDATES,
  readBootstrapSource,
  parseBootstrapTasks,
  normalizeBootstrapTask,
  maybeRunBootstrap,
};
