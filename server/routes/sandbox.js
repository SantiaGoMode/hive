const express  = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const router   = express.Router();
const sandbox  = require('../lib/sandbox');

// GET /api/sandbox/:agentId — container status + port map
router.get('/:agentId', (req, res) => {
  res.json(sandbox.getStatus(req.params.agentId));
});

// POST /api/sandbox/:agentId/start
router.post('/:agentId/start', async (req, res) => {
  try {
    await sandbox.ensureContainer(req.params.agentId);
    res.json({ success: true, ...sandbox.getStatus(req.params.agentId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sandbox/:agentId/reset
router.post('/:agentId/reset', async (req, res) => {
  try {
    await sandbox.reset(req.params.agentId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sandbox/:agentId/files  — workspace file tree
router.get('/:agentId/files', async (req, res) => {
  try {
    const { stdout } = await sandbox.exec(
      req.params.agentId,
      `find . -maxdepth 4 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.*' | sort`,
    );
    const files = stdout.trim().split('\n').filter(f => f && f !== '.');
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sandbox/:agentId/file?path=xxx — read a file
router.get('/:agentId/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const dir      = sandbox.sandboxDir(req.params.agentId);
  const resolved = require('path').resolve(require('path').join(dir, filePath));
  if (!resolved.startsWith(dir)) return res.status(403).json({ error: 'forbidden' });
  if (!require('fs').existsSync(resolved)) return res.status(404).json({ error: 'not found' });
  const content = require('fs').readFileSync(resolved, 'utf8');
  res.json({ content });
});

// PUT /api/sandbox/:agentId/file?path=xxx — write a file
router.put('/:agentId/file', (req, res) => {
  const filePath = req.query.path;
  const { content = '' } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const dir      = sandbox.sandboxDir(req.params.agentId);
  const resolved = require('path').resolve(require('path').join(dir, filePath));
  if (!resolved.startsWith(dir)) return res.status(403).json({ error: 'forbidden' });
  require('fs').mkdirSync(require('path').dirname(resolved), { recursive: true });
  require('fs').writeFileSync(resolved, content, 'utf8');
  res.json({ success: true });
});

// Proxy: /api/sandbox/:agentId/preview/:port/* → http://localhost:{hostPort}
router.use('/:agentId/preview/:port', (req, res, next) => {
  const hp = sandbox.hostPort(req.params.agentId, parseInt(req.params.port));
  if (!hp) return res.status(404).json({ error: `Port ${req.params.port} not forwarded. Use 3000, 5000, 8000, or 8080.` });
  createProxyMiddleware({
    target: `http://localhost:${hp}`,
    changeOrigin: true,
    pathRewrite: { [`^/api/sandbox/${req.params.agentId}/preview/${req.params.port}`]: '' },
    on: { error: (e, _req, _res) => _res.status(502).json({ error: 'App not reachable: ' + e.message }) },
  })(req, res, next);
});

module.exports = router;
