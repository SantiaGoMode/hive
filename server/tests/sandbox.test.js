const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const sandbox = require('../lib/sandbox');
const sandboxRouter = require('../routes/sandbox');
const { executeTool } = require('../lib/agentTools');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function appWithSandboxRoutes() {
  const app = express();
  app.use(express.json());
  app.use('/api/sandbox', sandboxRouter);
  return app;
}

describe('sandbox path containment', () => {
  it('resolves valid relative and /workspace-prefixed paths inside the workspace', () => {
    const root = tempDir('hive-sandbox-root-');
    try {
      const realRoot = fs.realpathSync(root);
      const resolved = sandbox.resolveWorkspacePath(root, 'src/app.js', { allowMissing: true });
      assert.equal(resolved, path.join(realRoot, 'src', 'app.js'));

      const workspacePrefixed = sandbox.resolveWorkspacePath(root, '/workspace/src/app.js', { allowMissing: true });
      assert.equal(workspacePrefixed, path.join(realRoot, 'src', 'app.js'));
    } finally {
      cleanup(root);
    }
  });

  it('rejects traversal, absolute host paths, sibling-prefix escapes, and symlink escapes', () => {
    const root = tempDir('hive-sandbox-root-');
    const sibling = `${root}-evil`;
    const outside = tempDir('hive-sandbox-outside-');
    try {
      fs.mkdirSync(sibling, { recursive: true });
      fs.writeFileSync(path.join(sibling, 'secret.txt'), 'sibling secret');
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-secret.txt'));

      assert.throws(
        () => sandbox.resolveWorkspacePath(root, `../${path.basename(sibling)}/secret.txt`, { allowMissing: false }),
        /inside \/workspace/
      );
      assert.throws(
        () => sandbox.resolveWorkspacePath(root, path.join(outside, 'secret.txt'), { allowMissing: false }),
        /relative to \/workspace/
      );
      assert.throws(
        () => sandbox.resolveWorkspacePath(root, 'link-secret.txt', { allowMissing: false }),
        /inside \/workspace/
      );
      assert.throws(
        () => sandbox.resolveWorkspacePath(root, 'link-secret.txt/new-file.txt', { allowMissing: true }),
        /inside \/workspace/
      );
    } finally {
      cleanup(root);
      cleanup(sibling);
      cleanup(outside);
    }
  });

  it('rejects unsafe agent ids before using them in paths or container names', () => {
    assert.throws(() => sandbox.sandboxDir('../escape'), /Invalid sandbox agent id/);
    assert.throws(() => sandbox.containerName('agent;docker rm -f x'), /Invalid sandbox agent id/);
    assert.equal(sandbox.containerName('agent_123-safe'), 'hive-sandbox-agent_123-safe');
  });

  it('confines sandbox HTTP file routes to the agent workspace', async () => {
    const app = appWithSandboxRoutes();
    const agentId = `route-agent-${Date.now()}`;
    const dir = sandbox.sandboxDir(agentId);
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'ok', 'utf8');

    await request(app)
      .get(`/api/sandbox/${agentId}/file`)
      .query({ path: 'ok.txt' })
      .expect(200)
      .expect(res => assert.equal(res.body.content, 'ok'));

    await request(app)
      .get(`/api/sandbox/${agentId}/file`)
      .query({ path: '../../secret.txt' })
      .expect(403);

    await request(app)
      .put(`/api/sandbox/${agentId}/file`)
      .query({ path: '../escape.txt' })
      .send({ content: 'nope' })
      .expect(403);

    await sandbox.reset(agentId);
  });

  it('confines agent file tools for read/write/delete/move/list operations', async () => {
    const agentId = `tool-agent-${Date.now()}`;
    const dir = sandbox.sandboxDir(agentId);
    const outside = tempDir('hive-tool-outside-');
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
      fs.symlinkSync(outside, path.join(dir, 'outside-link'));

      const writeOk = await executeTool('write_file', { path: 'docs/readme.md', content: 'hello' }, agentId);
      assert.equal(writeOk.success, true);

      const readOk = await executeTool('read_file', { path: '/workspace/docs/readme.md' }, agentId);
      assert.equal(readOk.content, 'hello');

      const readEscape = await executeTool('read_file', { path: '../../secret.txt' }, agentId);
      assert.match(readEscape.error, /inside \/workspace/);

      const writeEscape = await executeTool('write_file', { path: 'outside-link/new.txt', content: 'nope' }, agentId);
      assert.match(writeEscape.error, /inside \/workspace/);

      const moveEscape = await executeTool('move_file', { from: 'docs/readme.md', to: '../moved.md' }, agentId);
      assert.match(moveEscape.error, /inside \/workspace/);

      const listEscape = await executeTool('list_files', { directory: 'outside-link' }, agentId);
      assert.match(listEscape.error, /inside \/workspace/);

      const deleteEscape = await executeTool('delete_file', { path: 'outside-link/secret.txt' }, agentId);
      assert.match(deleteEscape.error, /inside \/workspace/);
      assert.equal(fs.existsSync(path.join(outside, 'secret.txt')), true);
    } finally {
      cleanup(outside);
      await sandbox.reset(agentId);
    }
  });
});
