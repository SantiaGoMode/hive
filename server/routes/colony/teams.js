// Colony teams routes.
//
// A Colony is a named, persistent team; runs live under it. These routes are
// declared BEFORE /:id so "teams" never matches as a colony-run id — ./index.js
// registers this module before the run/id routes to preserve that ordering.
const { DEFAULT_RECIPE_ID } = require('../../lib/colonyRecipes');
const { detectGitHubRepo, fetchRepoBoard } = require('../../lib/githubBoard');
const { stopColonyRun } = require('../../lib/colonyRunner');
const colonyTeams = require('../../lib/colonyTeams');
const db = require('../../db');
const { fs, activeRuns } = require('./shared');

module.exports = function registerTeamRoutes(router) {
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
      try { stopColonyRun(r.id); } catch {} /* abort is best-effort */
      const ac = activeRuns.get(r.id);
      if (ac) { try { ac.abort(); } catch {} /* abort is best-effort */ activeRuns.delete(r.id); }
    }
    try {
      colonyTeams.deleteTeam(team.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
