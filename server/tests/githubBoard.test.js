// Unit tests for githubBoard pure helpers (issue #46). No network — the fetch-
// based functions are exercised elsewhere; here we cover the deterministic
// parsing/normalization logic.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const board = require('../lib/githubBoard');

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
