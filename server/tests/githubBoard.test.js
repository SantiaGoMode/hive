// Unit tests for githubBoard pure helpers (issue #46). No network — the fetch-
// based functions are exercised elsewhere; here we cover the deterministic
// parsing/normalization logic.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const board = require('../lib/githubBoard');

function jsonResponse(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'ERR',
    text: async () => JSON.stringify(body),
  };
}

describe('parseGitHubRemote', () => {
  it('parses ssh remotes (with and without .git)', () => {
    assert.deepEqual(board.parseGitHubRemote('git@github.com:SantiaGoMode/hive.git'), { owner: 'SantiaGoMode', repo: 'hive' });
    assert.deepEqual(board.parseGitHubRemote('git@github.com:acme/Some.Repo'), { owner: 'acme', repo: 'Some.Repo' });
  });
  it('parses https remotes', () => {
    assert.deepEqual(board.parseGitHubRemote('https://github.com/SantiaGoMode/hive.git'), { owner: 'SantiaGoMode', repo: 'hive' });
    assert.deepEqual(board.parseGitHubRemote('http://github.com/a/b'), { owner: 'a', repo: 'b' });
  });
  it('returns null for non-GitHub or empty remotes', () => {
    assert.equal(board.parseGitHubRemote('git@gitlab.com:a/b.git'), null);
    assert.equal(board.parseGitHubRemote(''), null);
    assert.equal(board.parseGitHubRemote(null), null);
  });
});

describe('normalizeStatus', () => {
  it('maps common status names to canonical lanes', () => {
    assert.equal(board.normalizeStatus('Done'), 'done');
    assert.equal(board.normalizeStatus('Closed'), 'done');
    assert.equal(board.normalizeStatus('In Review'), 'review');
    assert.equal(board.normalizeStatus('WIP'), 'in_progress');
    assert.equal(board.normalizeStatus('To Do'), 'ready');
    assert.equal(board.normalizeStatus('Backlog'), 'backlog');
  });
  it('defaults unknown/empty status to backlog', () => {
    assert.equal(board.normalizeStatus('whatever'), 'backlog');
    assert.equal(board.normalizeStatus(''), 'backlog');
  });
});

describe('statusFromLabels', () => {
  it('returns the first non-backlog lane from labels (string or {name})', () => {
    assert.equal(board.statusFromLabels(['random', 'in progress']), 'in_progress');
    assert.equal(board.statusFromLabels([{ name: 'done' }]), 'done');
  });
  it('returns backlog for an explicit backlog label and for no match', () => {
    assert.equal(board.statusFromLabels(['backlog']), 'backlog');
    assert.equal(board.statusFromLabels(['random', 'misc']), 'backlog');
    assert.equal(board.statusFromLabels([]), 'backlog');
  });
});

describe('cardFromContent', () => {
  it('returns null without a number/title', () => {
    assert.equal(board.cardFromContent({}), null);
    assert.equal(board.cardFromContent({ number: 1 }), null);
  });
  it('builds an issue card; explicit project status overrides content.state', () => {
    const card = board.cardFromContent(
      { __typename: 'Issue', number: 7, title: 'Fix bug', state: 'open', bodyText: 'body', url: 'u', updatedAt: 't',
        assignees: { nodes: [{ login: 'me' }] }, labels: { nodes: [{ name: 'bug' }] } },
      { repo: 'a/b', projectTitle: 'Roadmap', status: 'In Review' },
    );
    assert.equal(card.id, 'issue-7');
    assert.equal(card.type, 'issue');
    assert.equal(card.status, 'review');         // from explicit status, not state:'open'
    assert.equal(card.status_label, 'In Review');
    assert.deepEqual(card.assignees, ['me']);
    assert.deepEqual(card.labels, ['bug']);
    assert.equal(card.source, 'GitHub Project: Roadmap');
  });
  it('marks pull requests and falls back to issue source', () => {
    const card = board.cardFromContent({ __typename: 'PullRequest', number: 9, title: 'PR', state: 'open' }, { repo: 'a/b' });
    assert.equal(card.type, 'pull_request');
    assert.equal(card.id, 'pull_request-9');
    assert.equal(card.source, 'GitHub Issues');
  });
});

describe('buildBoardComment', () => {
  it('renders summary, flow, links, and handoffs', () => {
    const md = board.buildBoardComment({
      recipe_id: 'dev_team',
      summary: 'Shipped the thing.',
      deliverable: { flow_complete: true, links: ['http://x'], handoffs: [{ from: 'a', to: 'b', status: 'done' }] },
    });
    assert.match(md, /Hive Colony update/);
    assert.match(md, /Shipped the thing\./);
    assert.match(md, /complete/);
    assert.match(md, /http:\/\/x/);
    assert.match(md, /a → b/);
  });
});

describe('review PR resolution', () => {
  it('extracts only explicit pull request references, not issue numbers', () => {
    assert.deepEqual(board.extractPullNumbers('Review the PR associated with #3', 'a/b'), []);
    assert.deepEqual(board.extractPullNumbers('Review PR #19 and https://github.com/a/b/pull/18', 'a/b'), [18, 19].sort((a, b) => a - b));
  });

  it('prefers the open PR that references the issue over older linked comments', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('/pulls?state=all')) {
        return jsonResponse([
          {
            number: 19,
            state: 'open',
            title: '[Colony] Define Technical Stack & Environment Setup',
            body: 'Goal includes https://github.com/SantiaGoMode/Hive-TaskMaster/issues/3',
            html_url: 'https://github.com/SantiaGoMode/Hive-TaskMaster/pull/19',
            head: { ref: 'colony-mr55', sha: 'head19', repo: { full_name: 'SantiaGoMode/Hive-TaskMaster' } },
            base: { ref: 'main', sha: 'base', repo: { full_name: 'SantiaGoMode/Hive-TaskMaster' } },
          },
          {
            number: 18,
            state: 'closed',
            title: '[Colony] Define Technical Stack & Environment Setup',
            body: 'older run',
            html_url: 'https://github.com/SantiaGoMode/Hive-TaskMaster/pull/18',
            head: { ref: 'colony-mr51', sha: 'head18', repo: { full_name: 'SantiaGoMode/Hive-TaskMaster' } },
            base: { ref: 'main', sha: 'base', repo: { full_name: 'SantiaGoMode/Hive-TaskMaster' } },
          },
        ]);
      }
      if (String(url).endsWith('/pulls/19')) {
        return jsonResponse({
          number: 19,
          state: 'open',
          title: '[Colony] Define Technical Stack & Environment Setup',
          html_url: 'https://github.com/SantiaGoMode/Hive-TaskMaster/pull/19',
          head: { ref: 'colony-mr55', sha: 'head19', repo: { full_name: 'SantiaGoMode/Hive-TaskMaster' } },
          base: { ref: 'main', sha: 'base', repo: { full_name: 'SantiaGoMode/Hive-TaskMaster' } },
        });
      }
      if (String(url).includes('/pulls/19/files')) {
        return jsonResponse([
          { filename: 'package.json', status: 'added', additions: 29, deletions: 0, changes: 29 },
          { filename: 'README.md', status: 'removed', additions: 0, deletions: 10, changes: 10 },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    try {
      const target = await board.resolveReviewPullRequest({
        owner: 'SantiaGoMode',
        repo: 'Hive-TaskMaster',
        card: { type: 'issue', number: 3, title: 'Define Technical Stack & Environment Setup' },
        goal: 'Review the PR associated with #3',
      });
      assert.equal(target.number, 19);
      assert.equal(target.base_ref, 'main');
      assert.equal(target.head_ref, 'colony-mr55');
      assert.deepEqual(target.changed_files.map(f => `${f.status}:${f.path}`), ['added:package.json', 'removed:README.md']);
      assert.ok(calls.some(url => url.includes('/pulls?state=all')));
      assert.ok(!calls.some(url => url.includes('/issues/3/comments')), 'open issue-referencing PR should avoid stale comment fallback');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
