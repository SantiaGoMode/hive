const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const { saveSession, getSessionsDir } = require('../lib/sessionWriter');
const { listSessions, getSession, deleteSession, searchSessions } = require('../lib/sessionReader');
const { buildSaveableMessages } = require('../lib/websocket');

const roots = [];
const agentIds = [];
const sessionRouter = require('../routes/sessions');

function createAgent(id, workspace = fs.mkdtempSync(path.join(os.tmpdir(), `hive-session-${id}-`))) {
  roots.push(workspace);
  agentIds.push(id);
  db.prepare(`
    INSERT INTO agents (id, name, model, workspace)
    VALUES (?, ?, ?, ?)
  `).run(id, `Agent ${id}`, 'fake-model', workspace);
  return { id, workspace };
}

function cleanup() {
  for (const id of agentIds) {
    try { db.prepare('DELETE FROM sessions_meta WHERE agent_id=?').run(id); } catch {}
    try { db.prepare('DELETE FROM agents WHERE id=?').run(id); } catch {}
  }
  agentIds.length = 0;

  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  roots.length = 0;
}

after(cleanup);

function findRoute(method, routePath) {
  return sessionRouter.stack.find(layer =>
    layer.route?.path === routePath && layer.route?.methods?.[method],
  )?.route?.stack?.[0]?.handle;
}

function callRoute(method, routePath, { params = {}, query = {}, body = {} } = {}) {
  const handler = findRoute(method, routePath);
  assert.ok(handler, `Missing ${method.toUpperCase()} ${routePath} route handler`);

  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  handler({ params, query, body }, res);
  return res;
}

describe('session writer and reader persistence', () => {
  it('saves sessions in the agent workspace used by the reader', () => {
    const { id, workspace } = createAgent('session-agent-a');

    saveSession(id, 'session-one', [
      { role: 'user', content: 'remember the blue notebook', timestamp: 1000 },
      { role: 'assistant', content: 'Saved that detail.', timestamp: 1001 },
    ]);

    const expectedFile = path.join(workspace, 'sessions', 'session-one.jsonl');
    assert.equal(getSessionsDir(id), path.join(workspace, 'sessions'));
    assert.ok(fs.existsSync(expectedFile), 'session file should be written under agent.workspace/sessions');

    const full = getSession(id, 'session-one');
    assert.equal(full.id, 'session-one');
    assert.equal(full.message_count, 2);
    assert.deepEqual(full.messages.map(m => m.content), ['remember the blue notebook', 'Saved that detail.']);

    const list = listSessions(id);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'session-one');
    assert.equal(list[0].preview, 'remember the blue notebook');
  });

  it('deletes persisted session files', () => {
    const { id, workspace } = createAgent('session-agent-delete');
    saveSession(id, 'delete-me', [{ role: 'user', content: 'temporary chat' }]);

    deleteSession(id, 'delete-me');

    assert.equal(getSession(id, 'delete-me'), null);
    assert.equal(fs.existsSync(path.join(workspace, 'sessions', 'delete-me.jsonl')), false);
  });

  it('searches across all agent workspaces and can be scoped to one agent', () => {
    const first = createAgent('session-agent-search-a');
    const second = createAgent('session-agent-search-b');

    saveSession(first.id, 'alpha', [
      { role: 'user', content: 'Find the launch checklist' },
      { role: 'assistant', content: 'The checklist is ready.' },
    ]);
    saveSession(second.id, 'beta', [
      { role: 'user', content: 'Find the billing checklist' },
      { role: 'assistant', content: 'Billing checklist found.' },
    ]);

    const global = searchSessions('checklist');
    assert.deepEqual(new Set(global.map(r => r.agent_id)), new Set([first.id, second.id]));

    const scoped = searchSessions('billing', second.id);
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].id, 'beta');
    assert.equal(scoped[0].matches[0].content, 'Find the billing checklist');
  });

  it('throws a clear error instead of writing to a stray path for unknown agents', () => {
    assert.throws(
      () => saveSession('missing-agent', 'ghost-session', [{ role: 'user', content: 'hello' }]),
      /Agent missing-agent not found/,
    );
  });
});

describe('session routes', () => {
  it('renames sessions and returns title metadata in lists', async () => {
    const { id } = createAgent('session-agent-route-rename');
    saveSession(id, 'rename-me', [{ role: 'user', content: 'draft title' }]);

    const rename = callRoute('patch', '/:agentId/:sessId', {
      params: { agentId: id, sessId: 'rename-me' },
      body: { title: 'Launch Notes' },
    });
    assert.equal(rename.statusCode, 200);
    assert.equal(rename.body.success, true);

    const list = callRoute('get', '/:agentId', {
      params: { agentId: id },
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.body[0].title, 'Launch Notes');
  });

  it('deletes session files and title metadata', async () => {
    const { id, workspace } = createAgent('session-agent-route-delete');
    saveSession(id, 'remove-me', [{ role: 'user', content: 'delete route coverage' }]);
    db.prepare('INSERT INTO sessions_meta (agent_id, session_id, title) VALUES (?, ?, ?)')
      .run(id, 'remove-me', 'Remove Me');

    const res = callRoute('delete', '/:agentId/:sessId', {
      params: { agentId: id, sessId: 'remove-me' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    assert.equal(fs.existsSync(path.join(workspace, 'sessions', 'remove-me.jsonl')), false);
    const meta = db.prepare('SELECT title FROM sessions_meta WHERE agent_id=? AND session_id=?').get(id, 'remove-me');
    assert.equal(meta, undefined);
  });

  it('searches all sessions through the HTTP API', async () => {
    const { id } = createAgent('session-agent-route-search');
    saveSession(id, 'route-search', [{ role: 'user', content: 'needle in session route' }]);

    const res = callRoute('get', '/search', {
      query: { q: 'needle' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.some(result => result.agent_id === id && result.id === 'route-search'));
  });
});

describe('websocket session serialization', () => {
  it('keeps only chat messages and stores text attachment content for persistence', () => {
    const saveable = buildSaveableMessages([
      { role: 'system', content: 'do not persist' },
      { role: 'user', content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        { type: 'text', text: 'attached notes' },
      ] },
      { role: 'assistant', content: 'prior answer' },
      { role: 'tool', content: 'tool payload' },
    ], 'final answer', 1234);

    assert.deepEqual(saveable, [
      { role: 'user', content: 'hello\nattached notes', timestamp: 1234 },
      { role: 'assistant', content: 'prior answer', timestamp: 1234 },
      { role: 'assistant', content: 'final answer', timestamp: 1234 },
    ]);
  });
});
