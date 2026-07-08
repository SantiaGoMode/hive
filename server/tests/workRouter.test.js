// Tests for intake matchmaking (colonies-first spec, R4). Uses throwaway git
// repos with a GitHub origin remote so repo ownership resolves for real, and
// asserts the suggestion-only contract: proposed items never start runs.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../db');
const teams = require('../lib/colonyTeams');
const workItems = require('../lib/colonyWorkItems');
const workRouter = require('../lib/workRouter');

const tmpDirs = [];
const createdTeams = [];

function makeGitRepo(slug) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-router-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', `git@github.com:${slug}.git`], { cwd: dir });
  return dir;
}

function makeTeam(extra = {}) {
  const t = teams.createTeam({ name: `Router team ${Date.now()}-${Math.round(performance.now())}`, ...extra });
  createdTeams.push(t.id);
  return t;
}

after(() => {
  db.prepare("DELETE FROM colony_work_items WHERE source IN ('board','webhook') AND source_ref LIKE 'router-test%'").run();
  for (const id of createdTeams) { try { db.prepare('DELETE FROM colony_teams WHERE id=?').run(id); } catch {} }
  for (const dir of tmpDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

describe('matchTeamForCard', () => {
  it('matches a card to the colony owning its repo', () => {
    const repo = makeGitRepo('acme/router-widget');
    const team = makeTeam({ repoPath: repo });
    const match = workRouter.matchTeamForCard({ repo: 'acme/router-widget', title: 'Widget breaks', labels: [] });
    assert.ok(match);
    assert.equal(match.team.id, team.id);
    assert.match(match.reason, /acme\/router-widget/);
  });

  it('returns null when no colony owns the repo', () => {
    assert.equal(workRouter.matchTeamForCard({ repo: 'nobody/owns-this', title: 'x', labels: [] }), null);
  });

  it('breaks repo ties deterministically (oldest colony) with a shared-repo reason', () => {
    const repo = makeGitRepo('acme/router-shared');
    const first = makeTeam({ repoPath: repo });
    makeTeam({ repoPath: repo });
    const match = workRouter.matchTeamForCard({ repo: 'acme/router-shared', title: 'Something', labels: [] });
    assert.equal(match.team.id, first.id);
    assert.match(match.reason, /shared by 2 colonies/);
  });
});

describe('proposeCard', () => {
  it('lands a matched card as proposed in the colony queue with a match_reason', () => {
    const repo = makeGitRepo('acme/router-propose');
    const team = makeTeam({ repoPath: repo });
    const item = workRouter.proposeCard(
      { id: 'issue-1', repo: 'acme/router-propose', title: 'New bug', labels: [] },
      { source: 'board', sourceRef: 'router-test-propose-1' },
    );
    assert.equal(item.team_id, team.id);
    assert.equal(item.status, 'proposed');
    assert.ok(item.match_reason.length > 0);
    assert.ok(workItems.listWorkItems(team.id).some(i => i.id === item.id));
  });

  it('lands an unmatched card in the Unrouted tray', () => {
    const item = workRouter.proposeCard(
      { id: 'issue-2', repo: 'nobody/owns-this', title: 'Orphan work', labels: [] },
      { source: 'board', sourceRef: 'router-test-unrouted-1' },
    );
    assert.equal(item.team_id, null);
    assert.ok(workItems.listUnroutedItems().some(i => i.id === item.id));
  });

  it('dedupes on (source, source_ref) — a dismissed proposal stays dismissed', () => {
    const first = workRouter.proposeCard(
      { id: 'issue-3', repo: 'nobody/owns-this', title: 'Dup', labels: [] },
      { source: 'board', sourceRef: 'router-test-dedupe-1' },
    );
    assert.ok(first);
    workItems.updateWorkItem(first.id, { status: 'dismissed' });
    const second = workRouter.proposeCard(
      { id: 'issue-3', repo: 'nobody/owns-this', title: 'Dup', labels: [] },
      { source: 'board', sourceRef: 'router-test-dedupe-1' },
    );
    assert.equal(second, null);
  });
});

describe('routeWebhookEvent', () => {
  const issuePayload = (repo, number) => ({
    action: 'opened',
    issue: { number, title: `Issue ${number}`, body: 'Details', html_url: `https://github.com/${repo}/issues/${number}`, labels: [], assignees: [] },
    repository: { full_name: repo },
  });

  it('proposes an opened issue to the owning colony and never starts a run', () => {
    const repo = makeGitRepo('acme/router-webhook');
    const team = makeTeam({ repoPath: repo });
    const runsBefore = db.prepare('SELECT COUNT(*) AS n FROM colonies').get().n;
    const item = workRouter.routeWebhookEvent({
      id: 'router-test-evt-1', webhook_id: 'router-test-wh', event_type: 'issues',
      payload: issuePayload('acme/router-webhook', 11),
    });
    assert.ok(item);
    assert.equal(item.team_id, team.id);
    assert.equal(item.status, 'proposed');
    assert.equal(item.source, 'webhook');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM colonies').get().n, runsBefore); // suggestion-only
  });

  it('ignores comment chatter and non-intake actions', () => {
    assert.equal(workRouter.routeWebhookEvent({
      id: 'router-test-evt-2', webhook_id: 'router-test-wh', event_type: 'issue_comment',
      payload: { action: 'created', comment: { body: 'hello' }, repository: { full_name: 'acme/router-webhook' } },
    }), null);
    assert.equal(workRouter.routeWebhookEvent({
      id: 'router-test-evt-3', webhook_id: 'router-test-wh', event_type: 'issues',
      payload: { ...issuePayload('acme/router-webhook', 12), action: 'closed' },
    }), null);
  });
});
