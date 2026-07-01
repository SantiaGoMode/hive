// Colony meta routes: colony list, recipes, model-plan proposal, and the
// global repo/project-board settings. Registered first so their fixed paths
// resolve before the dynamic /:id routes.
const { DEFAULT_RECIPE_ID, getColonyRecipe, listColonyRecipes } = require('../../lib/colonyRecipes');
const { detectGitHubRepo, fetchRepoBoard } = require('../../lib/githubBoard');
const colonyModels = require('../../lib/colonyModels');
const { listAllModels } = require('../../lib/providers/listModels');
const { listColonies } = require('../../lib/colonyRunner');
const { fs, getColonyRepoPath, setColonyRepoPath } = require('./shared');

module.exports = function registerMetaRoutes(router) {
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
};
