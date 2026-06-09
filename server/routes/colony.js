const express = require('express');
const router  = express.Router();
const fs = require('fs');
const { runColony, stopColonyRun, createColony, listColonies, getColony, deleteColony } = require('../lib/colonyRunner');
const { getBus, hasBus, maybeCleanup } = require('../lib/colonyBus');
const { CUSTOM_AUTO_RECIPE_ID, DEFAULT_RECIPE_ID, getColonyRecipe, listColonyRecipes } = require('../lib/colonyRecipes');
const { detectGitHubRepo, fetchRepoBoard, postIssueComment, createGitHubIssue, buildBoardComment } = require('../lib/githubBoard');
const protocol = require('../lib/colonyProtocol');
const colonyModels = require('../lib/colonyModels');
const { listAllModels } = require('../lib/providers/listModels');
const { normalizeTriggerConfig } = require('../lib/colonyTriggers');
const colonyTeams = require('../lib/colonyTeams');
const db = require('../db');

// Resolve a colony's seeded agents back to their protocol role keys by matching
// each agent's persona_role to the role metadata for the colony's recipe. Used
// to attach live agent_ids to the A2A ID cards.
function roleKeyForAgent(recipeId, agent) {
  if (!protocol.getFlow(recipeId) || !agent) return null;
  for (const [key, m] of Object.entries(protocol.DEV_TEAM_ROLES)) {
    if (m.role === agent.persona_role || m.name === agent.name) return key;
  }
  return null;
}

// "owner/repo" → { owner, repo } for write-back when no local repo path is set.
function parseRepoSlug(slug) {
  const m = String(slug || '').match(/^([^/]+)\/(.+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// buildBoardComment now lives in lib/githubBoard.js — shared with the runner's
// automatic post-run board update.

// Active AbortControllers keyed by colonyId
const activeRuns = new Map();

// Wall-clock safety cap. If a colony run hasn't finished in this many ms, we
// abort it. Prevents a stuck model or a worker agent in an infinite tool loop
// from pinning resources forever. Tuned generously — a full dev-team flow is
// six roles each doing real tool work on a local model; 15 minutes was
// routinely killing runs at ~2 of 7 plan steps.
const COLONY_MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// SSE plumbing shared between POST / and GET /:id/stream.
function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering if any
  res.flushHeaders();
}

function sseWrite(res, data) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function getColonyRepoPath() {
  return db.prepare("SELECT value FROM app_settings WHERE key='colony_repo_path'").get()?.value || '';
}

function setColonyRepoPath(repoPath) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('colony_repo_path', repoPath);
}

// GET /api/colony
router.get('/', (req, res) => {
  res.json(listColonies());
});

// GET /api/colony/recipes
router.get('/recipes', (req, res) => {
  res.json(listColonyRecipes());
});

// POST /api/colony/propose-models — the operator proposes a per-role model plan
// for a recipe, drawn from the available pool and respecting the cloud setting.
// The client shows it editable; the user can override before launch.
router.post('/propose-models', async (req, res) => {
  const recipeId = req.body.recipe_id || DEFAULT_RECIPE_ID;
  const cloudEnabled = !!req.body.cloud_enabled;
  const recipe = getColonyRecipe(recipeId);
  let grouped = {};
  try { grouped = await listAllModels(); } catch { grouped = {}; }
  const goal = String(req.body.goal || '');
  const { model_plan, source, reasoner } = await colonyModels.proposeModelPlanLLM(recipe, grouped, { cloudEnabled, goal });
  const pool = colonyModels.flattenPool(grouped, cloudEnabled).map(m => ({ id: m.id, provider: m.provider, name: m.name }));
  res.json({ recipe_id: recipeId, cloud_enabled: cloudEnabled, model_plan, source, reasoner, pool });
});

// GET /api/colony/repo
router.get('/repo', (req, res) => {
  const repo_path = getColonyRepoPath();
  const repo = repo_path ? detectGitHubRepo(repo_path) : null;
  res.json({ repo_path, repo });
});

// PUT /api/colony/repo
router.put('/repo', (req, res) => {
  const repoPath = String(req.body.repo_path || '').trim();
  if (!repoPath) {
    setColonyRepoPath('');
    return res.json({ repo_path: '', repo: null });
  }
  if (!fs.existsSync(repoPath)) return res.status(400).json({ error: 'Repo path does not exist' });
  const repo = detectGitHubRepo(repoPath);
  if (!repo) return res.status(400).json({ error: 'Repo path must be a git repository with a GitHub origin remote' });
  setColonyRepoPath(repoPath);
  res.json({ repo_path: repoPath, repo });
});

// GET /api/colony/project-board
router.get('/project-board', async (req, res) => {
  const repoPath = getColonyRepoPath();
  if (!repoPath) {
    return res.json({
      lanes: ['backlog', 'ready', 'in_progress', 'review', 'done'],
      source: null,
      repo: null,
      url: null,
      configured: false,
      error: 'No repository connected. Set a git repository path to load its project board.',
      cards: [],
    });
  }
  const board = await fetchRepoBoard({ cwd: repoPath });
  res.json({
    lanes: ['backlog', 'ready', 'in_progress', 'review', 'done'],
    configured: true,
    ...board,
  });
});

// ── Colony teams ──────────────────────────────────────────────────────────────
// A Colony is a named, persistent team; runs live under it. These routes are
// declared BEFORE /:id so "teams" never matches as a colony-run id.

// GET /api/colony/teams — all colonies with run stats.
router.get('/teams', (req, res) => {
  res.json(colonyTeams.listTeams());
});

// POST /api/colony/teams — create a colony (name + description + repo/config).
// Issues/tasks are NOT selected here — runs are launched from the colony page.
router.post('/teams', (req, res) => {
  const repoPath = String(req.body?.repo_path || '').trim();
  if (repoPath) {
    if (!fs.existsSync(repoPath)) return res.status(400).json({ error: 'Repo path does not exist' });
    if (!detectGitHubRepo(repoPath)) return res.status(400).json({ error: 'Repo path must be a git repository with a GitHub origin remote' });
  }
  try {
    const team = colonyTeams.createTeam({
      name: req.body?.name,
      description: req.body?.description,
      recipeId: req.body?.recipe_id || DEFAULT_RECIPE_ID,
      repoPath: repoPath || null,
      cloudEnabled: !!req.body?.cloud_enabled,
      githubWriteback: !!req.body?.github_writeback,
    });
    res.json(team);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/colony/teams/:tid — full overview: team, crew, performance, runs, artifacts.
router.get('/teams/:tid', (req, res) => {
  const overview = colonyTeams.teamOverview(req.params.tid);
  if (!overview) return res.status(404).json({ error: 'Colony not found' });
  const repo = overview.team.repo_path ? detectGitHubRepo(overview.team.repo_path) : null;
  res.json({ ...overview, repo });
});

// GET /api/colony/teams/:tid/board — the team repo's project board (work items
// are picked from the colony page when launching a run).
router.get('/teams/:tid/board', async (req, res) => {
  const team = colonyTeams.getTeam(req.params.tid);
  if (!team) return res.status(404).json({ error: 'Colony not found' });
  if (!team.repo_path) {
    return res.json({
      lanes: ['backlog', 'ready', 'in_progress', 'review', 'done'],
      source: null, repo: null, url: null, configured: false,
      error: 'This colony has no repository configured. Edit the colony to set one.',
      cards: [],
    });
  }
  const board = await fetchRepoBoard({ cwd: team.repo_path });
  res.json({ lanes: ['backlog', 'ready', 'in_progress', 'review', 'done'], configured: true, ...board });
});

// PUT /api/colony/teams/:tid — update name/description/repo/config.
router.put('/teams/:tid', (req, res) => {
  const repoPath = req.body?.repo_path;
  if (repoPath !== undefined && String(repoPath || '').trim()) {
    const p = String(repoPath).trim();
    if (!fs.existsSync(p)) return res.status(400).json({ error: 'Repo path does not exist' });
    if (!detectGitHubRepo(p)) return res.status(400).json({ error: 'Repo path must be a git repository with a GitHub origin remote' });
  }
  try {
    const team = colonyTeams.updateTeam(req.params.tid, req.body || {});
    if (!team) return res.status(404).json({ error: 'Colony not found' });
    res.json(team);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/colony/teams/:tid — delete the colony and all its runs.
router.delete('/teams/:tid', (req, res) => {
  const team = colonyTeams.getTeam(req.params.tid);
  if (!team) return res.status(404).json({ error: 'Colony not found' });
  const running = db.prepare("SELECT id FROM colonies WHERE team_id=? AND status='running'").all(team.id);
  for (const r of running) {
    try { stopColonyRun(r.id); } catch {}
    const ac = activeRuns.get(r.id);
    if (ac) { try { ac.abort(); } catch {} activeRuns.delete(r.id); }
  }
  try {
    colonyTeams.deleteTeam(team.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/colony/:id
router.get('/:id', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  res.json(colony);
});

// GET /api/colony/:id/artifact?path=relative/file — open a deliverable artifact.
// Artifacts are file paths relative to the run's repo; this serves their
// content (text only, size-capped, traversal-safe) so the UI can show them.
const ARTIFACT_MAX_BYTES = 256 * 1024;
router.get('/:id/artifact', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  const rel = String(req.query.path || '').trim();
  if (!rel) return res.status(400).json({ error: 'path is required' });
  const repoPath = colony.repo_path || getColonyRepoPath();
  if (!repoPath) return res.status(400).json({ error: 'This run has no repository path to resolve artifacts against.' });

  const path = require('path');
  const root = path.resolve(repoPath);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return res.status(400).json({ error: 'Artifact path escapes the run repository.' });
  }
  let stat;
  try { stat = fs.statSync(resolved); } catch { stat = null; }

  // Not in the working tree — the run committed it to its own branch
  // (colony-<id>) which may not be checked out. Read it from git instead.
  if (!stat) {
    const { execFileSync } = require('child_process');
    const relPosix = rel.split(path.sep).join('/');
    const branch = `colony-${colony.id}`;
    for (const ref of [branch, `origin/${branch}`]) {
      try {
        const buf = execFileSync('git', ['-C', root, 'show', `${ref}:${relPosix}`], {
          maxBuffer: ARTIFACT_MAX_BYTES + 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (buf.includes(0)) {
          return res.status(415).json({ error: `"${rel}" is a binary file — open it from the repo directly.` });
        }
        const truncated = buf.length > ARTIFACT_MAX_BYTES;
        return res.json({
          path: rel,
          size: buf.length,
          truncated,
          source: `git branch ${ref}`,
          content: buf.slice(0, ARTIFACT_MAX_BYTES).toString('utf8'),
        });
      } catch {
        // try the next ref
      }
    }
    return res.status(404).json({ error: `Artifact not found in the working tree or on the run's branch (${branch}): ${rel}. It may have been moved or the branch deleted.` });
  }

  if (!stat.isFile()) return res.status(400).json({ error: 'Artifact path is not a file' });

  const truncated = stat.size > ARTIFACT_MAX_BYTES;
  const fd = fs.openSync(resolved, 'r');
  let buf;
  try {
    buf = Buffer.alloc(Math.min(stat.size, ARTIFACT_MAX_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buf.includes(0)) {
    return res.status(415).json({ error: `"${rel}" is a binary file (${stat.size} bytes) — open it from the repo directly.` });
  }
  res.json({ path: rel, size: stat.size, truncated, content: buf.toString('utf8') });
});

// PUT /api/colony/:id/triggers — edit per-colony webhook routing.
router.put('/:id/triggers', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  const triggerConfig = normalizeTriggerConfig(req.body?.trigger_config || req.body || null);
  const shouldClear = !triggerConfig?.webhook_id && (!triggerConfig?.event_types || triggerConfig.event_types.length === 0);
  db.prepare('UPDATE colonies SET trigger_config=?, updated_at=unixepoch() WHERE id=?')
    .run(shouldClear ? null : JSON.stringify(triggerConfig), colony.id);
  res.json({ success: true, trigger_config: shouldClear ? null : triggerConfig });
});

// GET /api/colony/:id/stream — resumable SSE tail.
// Replays log entries from the DB with seq > ?since= (default 0), then
// attaches to the per-colony event bus for live updates if the run is still
// ongoing. Safe to open from multiple tabs at once and safe to reopen after
// a browser refresh.
router.get('/:id/stream', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });

  sseHeaders(res);
  sseWrite(res, { type: 'colony_id', colonyId: colony.id });

  const since = parseInt(req.query.since || '0', 10) || 0;

  // Replay historical entries (already persisted).
  let lastSentSeq = since;
  const historical = Array.isArray(colony.log) ? colony.log : [];
  for (const entry of historical) {
    const seq = entry.seq || 0;
    if (seq > since) {
      sseWrite(res, { type: 'log_entry', entry });
      if (seq > lastSentSeq) lastSentSeq = seq;
    }
  }

  // Also replay agent_ready-style synthetic events for each historical agent_ready
  // log entry so the client color map / filter chips work without extra parsing.
  for (const entry of historical) {
    if (entry.kind === 'agent_ready' && entry.agent) {
      sseWrite(res, { type: 'agent_ready', role: entry.role, agent: entry.agent });
    }
  }

  // If the run is no longer active, close immediately.
  if (colony.status !== 'running' || !hasBus(colony.id)) {
    sseWrite(res, { type: 'done', status: colony.status });
    res.end();
    return;
  }

  // Otherwise attach to the live bus. Filter out log_entry events we've already
  // sent historically, so clients don't see duplicates across the handoff.
  const bus = getBus(colony.id);
  const listener = (event) => {
    if (event.type === 'log_entry' && event.entry?.seq && event.entry.seq <= lastSentSeq) {
      return;
    }
    if (event.type === 'log_entry' && event.entry?.seq > lastSentSeq) {
      lastSentSeq = event.entry.seq;
    }
    sseWrite(res, event);
  };
  bus.on('event', listener);

  res.on('close', () => {
    bus.off('event', listener);
    maybeCleanup(colony.id);
  });
});

// POST /api/colony — create + immediately stream via SSE
router.post('/', async (req, res) => {
  const { goal, model } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal is required' });
  if (!model?.trim()) return res.status(400).json({ error: 'model is required' });

  // Runs are launched under a colony team — the team carries the repo/project,
  // recipe, and base config set at colony creation. team_id is optional only
  // for backward compatibility (tests, webhooks, scripts).
  const team = req.body.team_id ? colonyTeams.getTeam(req.body.team_id) : null;
  if (req.body.team_id && !team) return res.status(400).json({ error: 'unknown team_id' });

  const recipeId = team?.recipe_id || req.body.recipe_id || DEFAULT_RECIPE_ID;
  if (getColonyRecipe(recipeId).id !== recipeId) return res.status(400).json({ error: 'unknown recipe_id' });

  // Repo comes from the team; fall back to body / global path for teamless launches.
  const repoPath = (team?.repo_path || req.body.repo_path || getColonyRepoPath() || '').trim() || null;
  const boardCard = req.body.board_card && typeof req.body.board_card === 'object' ? req.body.board_card : null;
  const cloudEnabled = team ? team.cloud_enabled : !!req.body.cloud_enabled;
  const githubWriteback = team ? team.github_writeback : !!req.body.github_writeback;
  const modelPlan = req.body.model_plan && typeof req.body.model_plan === 'object' ? req.body.model_plan : null;
  // Reasoning is no longer a per-run user toggle: the operator always reasons
  // and decides per-agent reasoning at run start (see colonyRunner).
  const reasoningMode = 'auto';
  let triggerConfig = normalizeTriggerConfig(req.body.trigger_config);
  if (triggerConfig && !triggerConfig.repo && repoPath) {
    const detected = detectGitHubRepo(repoPath);
    if (detected) triggerConfig = { ...triggerConfig, repo: `${detected.owner}/${detected.repo}` };
  }
  if (triggerConfig && !triggerConfig.webhook_id && triggerConfig.event_types.length === 0) triggerConfig = null;

  // Reject a plan that uses cloud models when cloud is disabled, before launch.
  const gate = colonyModels.gatePlan({ operator: model, ...(modelPlan || {}) }, cloudEnabled);
  if (!gate.ok) return res.status(400).json({ error: gate.error });

  const colonyId = createColony(goal.trim(), model.trim(), recipeId, { repoPath, boardCard, cloudEnabled, githubWriteback, modelPlan, reasoningMode, triggerConfig, teamId: team?.id || null });

  sseHeaders(res);

  const emit = (data) => sseWrite(res, data);

  emit({ type: 'colony_id', colonyId });

  const ac = new AbortController();
  activeRuns.set(colonyId, ac);

  // Wall-clock timeout — abort the run if it exceeds COLONY_MAX_DURATION_MS.
  // Cleared in the finally block. We also emit a synthetic log line via the
  // bus so the UI can show why the run stopped.
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try { ac.abort(); } catch {}
  }, COLONY_MAX_DURATION_MS);

  // Subscribe this POST client to the per-colony bus. runColony publishes
  // every event to the bus as well as calling the legacy onEvent callback,
  // so we can drop the onEvent path here once every caller migrates. For now
  // we keep it for safety. (The bus listener sees all events; onEvent is no-op
  // to avoid duplicates.)
  const bus = getBus(colonyId);
  let lastSeqSent = 0;
  const listener = (event) => {
    if (event.type === 'log_entry' && event.entry?.seq && event.entry.seq <= lastSeqSent) {
      return;
    }
    if (event.type === 'log_entry' && event.entry?.seq > lastSeqSent) {
      lastSeqSent = event.entry.seq;
    }
    emit(event);
  };
  bus.on('event', listener);

  // Use res.on('close') — NOT req.on('close'). In Express 5 / Node HTTP, req 'close'
  // fires as soon as the request body has been fully read (almost immediately for a
  // small POST), which would falsely abort every run the instant it starts. res 'close'
  // only fires when the response stream ends or the client actually disconnects.
  res.on('close', () => {
    if (!res.writableFinished) {
      ac.abort();
    }
    bus.off('event', listener);
    activeRuns.delete(colonyId);
    maybeCleanup(colonyId);
  });

  try {
    await runColony(colonyId, null, ac.signal);
  } catch (e) {
    // Safety net: runColony should handle its own errors internally, but if anything
    // escapes (early throw before its try/catch, etc.), we must update the DB status
    // so the colony doesn't stay stuck at 'running' forever.
    const isAbort = e.name === 'AbortError' || ac.signal.aborted || e.message === 'Colony run was stopped';
    const finalStatus = isAbort ? 'stopped' : 'error';
    try {
      db.prepare('UPDATE colonies SET status=?, updated_at=unixepoch() WHERE id=?').run(finalStatus, colonyId);
    } catch {}
    const message = timedOut
      ? `Colony exceeded wall-clock limit of ${Math.round(COLONY_MAX_DURATION_MS / 60000)} minutes and was aborted`
      : e.message;
    emit({ type: isAbort ? 'done' : 'error', status: finalStatus, message });
  } finally {
    clearTimeout(timeoutHandle);
    bus.off('event', listener);
    activeRuns.delete(colonyId);
    maybeCleanup(colonyId);
    if (!res.writableEnded) res.end();
  }
});

// POST /api/colony/:id/stop
// Stop is owned by the runner's registry, which covers every launch path
// (direct POST, bootstrap accept, webhook triggers) for the run's full
// lifetime — not just while the original POST handler is open.
router.post('/:id/stop', (req, res) => {
  const colonyId = req.params.id;
  const colony = getColony(colonyId);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });

  // Abort the live run if there is one (runner registry), and also abort the
  // route-local controller (clears the POST wall-clock timeout path).
  const stoppedLive = stopColonyRun(colonyId);
  const ac = activeRuns.get(colonyId);
  if (ac) {
    try { ac.abort(); } catch {}
    activeRuns.delete(colonyId);
  }

  if (stoppedLive || ac) {
    // The runner's abort handling persists status='stopped' and emits 'done'.
    return res.json({ success: true, stopped: true });
  }

  // No live run, but the row may be stuck at 'running' (e.g. server restarted
  // mid-run). Reconcile the DB so the UI stops showing a phantom run.
  if (colony.status === 'running') {
    db.prepare("UPDATE colonies SET status='stopped', updated_at=unixepoch() WHERE id=?").run(colonyId);
    if (hasBus(colonyId)) {
      getBus(colonyId).emit('event', { type: 'done', status: 'stopped' });
    }
    return res.json({ success: true, stopped: true, message: 'No live run; stale running status reconciled' });
  }

  res.json({ success: true, stopped: false, message: 'Not running' });
});

// POST /api/colony/:id/directions — queue human direction for the operator.
// The runner drains this between review rounds and marks it delivered.
router.post('/:id/directions', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  if (colony.status !== 'running') return res.status(400).json({ error: 'Directions can only be sent to a running colony.' });
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'content is required' });
  const targetRole = req.body?.target_role ? String(req.body.target_role) : null;
  const info = db.prepare('INSERT INTO colony_directions (colony_id, content, target_role) VALUES (?, ?, ?)')
    .run(colony.id, content, targetRole);
  protocol.writeBlackboard(colony.id, 'user', 'message', content, { direction_id: info.lastInsertRowid, queued_for_operator: true, target_role: targetRole });
  if (hasBus(colony.id)) {
    getBus(colony.id).emit('event', {
      type: 'direction_queued',
      direction: { id: info.lastInsertRowid, content, target_role: targetRole },
    });
  }
  res.json({ success: true, direction: { id: info.lastInsertRowid, status: 'queued', content, target_role: targetRole } });
});

// POST /api/colony/:id/bootstrap/accept — human gate for empty-board task drafts.
router.post('/:id/bootstrap/accept', async (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  let tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : colony.bootstrap_tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return res.status(400).json({ error: 'No bootstrap tasks are available to accept.' });
  if (activeRuns.has(colony.id)) return res.status(400).json({ error: 'Colony is already running.' });

  // Handle GitHub write-back
  if (colony.github_writeback && colony.repo_path) {
    const detected = detectGitHubRepo(colony.repo_path);
    if (detected) {
      try {
        const updatedTasks = [];
        for (const task of tasks) {
          const bodyLines = [];
          if (task.description) bodyLines.push(task.description);
          if (Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length) {
            bodyLines.push('', '### Acceptance Criteria');
            task.acceptance_criteria.forEach(c => bodyLines.push(`- [ ] ${c}`));
          }
          const issue = await createGitHubIssue({
            owner: detected.owner,
            repo: detected.repo,
            title: task.title,
            body: bodyLines.join('\n')
          });
          updatedTasks.push({ ...task, github_issue_number: issue.number });
        }
        tasks = updatedTasks;
      } catch (err) {
        console.error('Failed to create GitHub issues during bootstrap:', err);
        protocol.writeBlackboard(colony.id, 'system', 'blocker',
          `Failed to create GitHub issues for bootstrap tasks: ${err.message}. Please check your GitHub token and permissions.`,
          { error: err.message });
      }
    }
  }

  const plan = {
    steps: tasks.map((task, i) => ({
      id: String(task.id || i + 1),
      description: [
        task.title,
        task.description ? `- ${task.description}` : '',
        Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length
          ? `Acceptance: ${task.acceptance_criteria.join('; ')}`
          : '',
        task.github_issue_number ? `(GitHub Issue #${task.github_issue_number})` : ''
      ].filter(Boolean).join(' '),
      github_issue_number: task.github_issue_number,
      assigned_to: null,
      status: 'pending',
    })),
    updated_at: Date.now(),
    source: 'bootstrap_tasks',
  };
  db.prepare("UPDATE colonies SET bootstrap_tasks=?, bootstrap_accepted=1, plan=?, status='running', updated_at=unixepoch() WHERE id=?")
    .run(JSON.stringify(tasks), JSON.stringify(plan), colony.id);
  protocol.writeBlackboard(colony.id, 'human-reviewer', 'message',
    `Accepted ${tasks.length} bootstrap task(s). The colony may now continue with the normal delivery flow.`,
    { bootstrap_accepted: true, task_count: tasks.length });

  const ac = new AbortController();
  activeRuns.set(colony.id, ac);
  setImmediate(async () => {
    try {
      await runColony(colony.id, null, ac.signal);
    } finally {
      activeRuns.delete(colony.id);
      maybeCleanup(colony.id);
    }
  });

  res.json({ success: true, colony: getColony(colony.id) });
});

// ── Communication Protocol: A2A/ACP REST surface ─────────────────────────────

// GET /api/colony/recipes/:rid/flow — the role-specific handoff flow + cards
// (A2A discovery for a recipe, independent of any running colony).
router.get('/recipes/:rid/flow', (req, res) => {
  const rid = req.params.rid;
  const flow = protocol.getFlow(rid);
  if (!flow) return res.status(404).json({ error: `No communication protocol flow for recipe "${rid}"` });
  res.json({ recipe_id: rid, flow, cards: protocol.buildAllCards(rid) });
});

// GET /api/colony/:id/agents — list A2A ID cards for the colony's roster.
router.get('/:id/agents', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  if (!protocol.hasProtocol(colony.recipe_id)) {
    return res.json({ recipe_id: colony.recipe_id, protocol: false, cards: [] });
  }
  const byKey = {};
  for (const a of colony.agents) {
    const key = roleKeyForAgent(colony.recipe_id, a);
    if (key) byKey[key] = a;
  }
  const cards = protocol.buildAllCards(colony.recipe_id, { colonyId: colony.id }).map(card => ({
    ...card,
    agent_id: byKey[card.key]?.id || null,
    name: byKey[card.key]?.name || card.name,
  }));
  res.json({ recipe_id: colony.recipe_id, protocol: true, cards });
});

// GET /api/colony/:id/agents/:key/card — a single .agent.json ID card.
router.get('/:id/agents/:key/card', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  const agent = colony.agents.find(a => roleKeyForAgent(colony.recipe_id, a) === req.params.key);
  const card = protocol.buildAgentCard(colony.recipe_id, req.params.key, {
    colonyId: colony.id,
    agentId: agent?.id || null,
    name: agent?.name,
    tools: undefined,
  });
  if (!card) return res.status(404).json({ error: `No role "${req.params.key}" in recipe "${colony.recipe_id}"` });
  res.json(card);
});

// GET /api/colony/:id/blackboard — read the shared context layer.
router.get('/:id/blackboard', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  const entries = protocol.readBlackboard(colony.id, {
    entryType: req.query.entry_type,
    agent: req.query.agent,
    limit: req.query.limit,
  });
  res.json({ colony_id: colony.id, count: entries.length, entries });
});

// POST /api/colony/:id/blackboard — append an entry (ACP message ingress).
router.post('/:id/blackboard', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  const { agent, entry_type, content } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'content is required' });
  const entry = protocol.writeBlackboard(colony.id, agent || 'external', entry_type || 'message', content);
  res.json({ success: true, entry });
});

// POST /api/colony/:id/acp/messages — standardized ACP message ingress.
router.post('/:id/acp/messages', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  const { from, to, performative, content } = req.body || {};
  if (content === undefined || content === null) return res.status(400).json({ error: 'content is required' });
  protocol.writeBlackboard(colony.id, from || 'external', 'message',
    typeof content === 'string' ? content : JSON.stringify(content), { to: to || null, performative: performative || 'inform' });
  res.json(protocol.acpEnvelope('message', { from: from || 'external', to, performative, content }));
});

// GET /api/colony/:id/handoffs — the handoff ledger (command objects).
router.get('/:id/handoffs', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  res.json({ colony_id: colony.id, handoffs: protocol.listHandoffs(colony.id) });
});

// GET /api/colony/:id/handoffs/:hid/context — on-demand upstream history.
router.get('/:id/handoffs/:hid/context', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  const context = protocol.getHandoffContext(req.params.hid);
  if (context.error) return res.status(404).json(context);
  if (context.handoff?.colony_id !== colony.id) return res.status(404).json({ error: 'Handoff not found for this colony' });
  res.json(context);
});

// POST /api/colony/:id/handoffs/:hid/approve — human-in-the-loop decision on a
// critical handoff. decision: "approved" | "rejected".
router.post('/:id/handoffs/:hid/approve', (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });
  const handoff = protocol.getHandoff(req.params.hid);
  if (!handoff || handoff.colony_id !== colony.id) return res.status(404).json({ error: 'Handoff not found' });
  const decision = String(req.body?.decision || '').toLowerCase();
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
  }
  const note = req.body?.note ? String(req.body.note) : null;
  const updated = protocol.updateHandoff(handoff.id, {
    status: decision,
    human_decision: decision,
    human_note: note,
  });
  protocol.writeBlackboard(colony.id, 'human-reviewer', 'message',
    `Human ${decision} handoff ${handoff.from_agent}→${handoff.to_agent}${note ? `: ${note}` : ''}`,
    { handoff_id: handoff.id });
  res.json({ success: true, handoff: updated });
});

// POST /api/colony/:id/board/comment — human-triggered write-back: post the
// colony's deliverable (or a custom body) as a comment on the linked GitHub
// issue/PR. The safe half of board write-back; no destructive board mutations.
router.post('/:id/board/comment', async (req, res) => {
  const colony = getColony(req.params.id);
  if (!colony) return res.status(404).json({ error: 'Colony not found' });

  const card = colony.board_card;
  if (!card || !card.number) {
    return res.status(400).json({ error: 'This colony has no linked board work-item to comment on.' });
  }
  const repoPath = colony.repo_path || getColonyRepoPath();
  const repo = repoPath ? detectGitHubRepo(repoPath) : (card.repo ? parseRepoSlug(card.repo) : null);
  if (!repo) {
    return res.status(400).json({ error: 'Could not resolve a GitHub repo for this colony. Set its repo path.' });
  }

  const body = (req.body?.body && String(req.body.body).trim()) || buildBoardComment(colony);
  try {
    const comment = await postIssueComment({ owner: repo.owner, repo: repo.repo, number: card.number, body });
    res.json({ success: true, url: comment?.html_url || null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/colony/:id
router.delete('/:id', (req, res) => {
  const ac = activeRuns.get(req.params.id);
  if (ac) { ac.abort(); activeRuns.delete(req.params.id); }
  try {
    deleteColony(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
