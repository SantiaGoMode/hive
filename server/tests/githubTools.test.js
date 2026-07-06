// First-party GitHub colony tools (server/lib/tools/githubTools.js).
// Covers the repo-context resolution guardrails that fire BEFORE any network
// call, so the tests are deterministic regardless of the host's GitHub auth.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { executeTool, getToolDefinitions } = require('../lib/agentTools');

function run(name, args, colonyContext) {
  return executeTool(name, args, null, 'http://ollama.test', 0, null, null, null, 4, null, colonyContext);
}

describe('github colony tools', () => {
  it('exposes the github tool group', () => {
    const defs = getToolDefinitions(['github']).map(d => d.function?.name);
    for (const t of ['github_comment', 'github_update_issue', 'github_create_issue', 'github_security_alerts']) {
      assert.ok(defs.includes(t), `github group must expose ${t}`);
    }
  });

  it('refuses to write when not inside a colony run', async () => {
    const res = await run('github_comment', { body: 'hi' }, null);
    assert.match(res.error, /only available inside a Colony run/i);
  });

  it('errors clearly when the run has no linked GitHub repo', async () => {
    const db = require('../db');
    const colonyId = 'gh-tools-test-norepo';
    db.prepare('INSERT INTO colonies (id, goal, model, status, recipe_id) VALUES (?, ?, ?, ?, ?)')
      .run(colonyId, 'Goal', 'm', 'running', 'development_team');
    try {
      const res = await run('github_comment', { body: 'hi' }, { colonyId });
      assert.match(res.error, /No GitHub repository is linked/i);
    } finally {
      db.prepare('DELETE FROM colonies WHERE id=?').run(colonyId);
    }
  });

  it('resolves owner/repo/number from the linked board card and reports a missing token as a blocker', async () => {
    const db = require('../db');
    const { githubToken } = require('../lib/config');
    // Skip if the host actually has a GitHub token — this case asserts the
    // no-token blocker path, which only fires when none is configured.
    if (githubToken()) return;
    const colonyId = 'gh-tools-test-card';
    const boardCard = { repo: 'acme/widgets', number: 42, url: 'https://github.com/acme/widgets/issues/42' };
    db.prepare('INSERT INTO colonies (id, goal, model, status, recipe_id, board_card) VALUES (?, ?, ?, ?, ?, ?)')
      .run(colonyId, 'Goal', 'm', 'running', 'development_team', JSON.stringify(boardCard));
    try {
      const res = await run('github_comment', { body: 'progress' }, { colonyId });
      assert.equal(res.permission_required, true);
      assert.match(res.error, /no GitHub token/i);
    } finally {
      db.prepare('DELETE FROM colonies WHERE id=?').run(colonyId);
    }
  });
});
