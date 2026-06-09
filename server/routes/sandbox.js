const express  = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const router   = express.Router();
const sandbox  = require('../lib/sandbox');

function sendSandboxError(res, error) {
  if (/inside|relative|invalid|agent id/i.test(error.message)) return res.status(403).json({ error: 'forbidden' });
  if (/not found/i.test(error.message)) return res.status(404).json({ error: 'not found' });
  return res.status(500).json({ error: error.message });
}

// GET /api/sandbox/:agentId — container status + port map
router.get('/:agentId', (req, res) => {
  try {
    res.json(sandbox.getStatus(req.params.agentId));
  } catch (e) {
    sendSandboxError(res, e);
  }
});

// POST /api/sandbox/:agentId/start
router.post('/:agentId/start', async (req, res) => {
  try {
    await sandbox.ensureContainer(req.params.agentId);
    res.json({ success: true, ...sandbox.getStatus(req.params.agentId) });
  } catch (e) {
    sendSandboxError(res, e);
  }
});

// POST /api/sandbox/:agentId/reset
router.post('/:agentId/reset', async (req, res) => {
  try {
    await sandbox.reset(req.params.agentId);
    res.json({ success: true });
  } catch (e) {
    sendSandboxError(res, e);
  }
});

// GET /api/sandbox/:agentId/files  — workspace file tree
router.get('/:agentId/files', async (req, res) => {
  try {
    const files = sandbox.listWorkspaceFiles(req.params.agentId, '.', { maxDepth: 4, limit: 500 });
    res.json({ files });
  } catch (e) {
    sendSandboxError(res, e);
  }
});

// GET /api/sandbox/:agentId/file?path=xxx — read a file
router.get('/:agentId/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const dir = sandbox.workspaceDir(req.params.agentId);
    const resolved = sandbox.resolveWorkspacePath(dir, filePath, { allowMissing: false });
    const content = require('fs').readFileSync(resolved, 'utf8');
    res.json({ content });
  } catch (e) {
    sendSandboxError(res, e);
  }
});

// PUT /api/sandbox/:agentId/file?path=xxx — write a file
router.put('/:agentId/file', (req, res) => {
  const filePath = req.query.path;
  const { content = '' } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const dir = sandbox.workspaceDir(req.params.agentId);
    const resolved = sandbox.resolveWorkspacePath(dir, filePath, { allowMissing: true });
    require('fs').mkdirSync(require('path').dirname(resolved), { recursive: true });
    require('fs').writeFileSync(resolved, content, 'utf8');
    res.json({ success: true });
  } catch (e) {
    sendSandboxError(res, e);
  }
});

// Proxy: /api/sandbox/:agentId/preview/:port/* → http://localhost:{hostPort}
router.use('/:agentId/preview/:port', (req, res, next) => {
  try {
    const hp = sandbox.hostPort(req.params.agentId, parseInt(req.params.port));
    if (!hp) return res.status(404).json({ error: `Port ${req.params.port} not forwarded. Use 3000, 5000, 8000, or 8080.` });
    createProxyMiddleware({
      target: `http://localhost:${hp}`,
      changeOrigin: true,
      pathRewrite: { [`^/api/sandbox/${req.params.agentId}/preview/${req.params.port}`]: '' },
      on: { error: (e, _req, _res) => _res.status(502).json({ error: 'App not reachable: ' + e.message }) },
    })(req, res, next);
  } catch (e) {
    sendSandboxError(res, e);
  }
});

module.exports = router;
