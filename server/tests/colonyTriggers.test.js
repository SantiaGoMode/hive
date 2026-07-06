const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { createColony, getColony } = require('../lib/colonyRunner');
const {
  configMatchesEvent,
  normalizeTriggerConfig,
  processWebhookEvent,
} = require('../lib/colonyTriggers');

const created = [];

after(() => {
  for (const id of created) {
    try { db.prepare('DELETE FROM colonies WHERE id=?').run(id); } catch {}
  }
  try { db.prepare('DELETE FROM colony_trigger_events').run(); } catch {}
  try { db.prepare("DELETE FROM webhooks WHERE id LIKE 'wh-trigger-%'").run(); } catch {}
  try { db.prepare("DELETE FROM webhook_events WHERE webhook_id LIKE 'wh-trigger-%'").run(); } catch {}
});

describe('colony trigger config', () => {
  it('normalizes trigger config defaults', () => {
    const config = normalizeTriggerConfig({
      webhook_id: 'wh_1',
      repo: 'acme/api',
      event_types: ['Issue', 'issue', 'comment'],
    });
    assert.deepEqual(config, {
      webhook_id: 'wh_1',
      repo: 'acme/api',
      event_types: ['issue', 'comment'],
      comment_token: '@hive',
      paused: false,
    });
  });

  it('persists trigger_config on colony records', () => {
    const id = createColony('Route trigger config test', 'llama3', 'development_team', {
      triggerConfig: normalizeTriggerConfig({
        webhook_id: 'wh-trigger-route',
        repo: 'acme/api',
        event_types: ['issue', 'comment'],
        comment_token: '@hive',
      }),
    });
    created.push(id);

    const colony = getColony(id);
    assert.equal(colony.trigger_config.webhook_id, 'wh-trigger-route');
    assert.equal(colony.trigger_config.repo, 'acme/api');
    assert.deepEqual(colony.trigger_config.event_types, ['issue', 'comment']);
  });
});

describe('colony trigger matching and processing', () => {
  const issueEvent = {
    id: 'evt-issue-opened-1',
    webhook_id: 'wh-trigger-1',
    event_type: 'issues',
    payload: {
      action: 'opened',
      repository: { full_name: 'acme/api' },
      issue: {
        id: 42,
        number: 142,
        title: 'Add v2 endpoint',
        body: 'Ship the next endpoint.',
        html_url: 'https://github.com/acme/api/issues/142',
        labels: [{ name: 'ready' }],
        assignees: [{ login: 'cris' }],
      },
    },
  };

  it('matches configured issue events for the same repo', () => {
    const config = normalizeTriggerConfig({
      webhook_id: 'wh-trigger-1',
      repo: 'acme/api',
      event_types: ['issue'],
    });
    assert.deepEqual(configMatchesEvent(config, issueEvent), { ok: true, kind: 'issue' });
  });

  it('requires the comment token for comment triggers', () => {
    const config = normalizeTriggerConfig({
      webhook_id: 'wh-trigger-1',
      repo: 'acme/api',
      event_types: ['comment'],
      comment_token: '@hive',
    });
    const withoutToken = {
      id: 'evt-comment-1',
      webhook_id: 'wh-trigger-1',
      event_type: 'issue_comment',
      payload: {
        action: 'created',
        repository: { full_name: 'acme/api' },
        issue: { number: 142, title: 'Add v2 endpoint', html_url: 'https://github.com/acme/api/issues/142' },
        comment: { body: 'Looks good.', html_url: 'https://github.com/acme/api/issues/142#issuecomment-1' },
      },
    };
    const withToken = {
      ...withoutToken,
      id: 'evt-comment-2',
      payload: {
        ...withoutToken.payload,
        comment: { ...withoutToken.payload.comment, body: '@hive take a look at this follow-up', author_association: 'OWNER' },
      },
    };

    assert.equal(configMatchesEvent(config, withoutToken).ok, false);
    assert.deepEqual(configMatchesEvent(config, withToken), { ok: true, kind: 'comment' });
  });

  it('rejects comment triggers from untrusted authors even with the token', () => {
    const config = normalizeTriggerConfig({
      webhook_id: 'wh-trigger-1',
      repo: 'acme/api',
      event_types: ['comment'],
      comment_token: '@hive',
    });
    const base = {
      id: 'evt-comment-untrusted',
      webhook_id: 'wh-trigger-1',
      event_type: 'issue_comment',
      payload: {
        action: 'created',
        repository: { full_name: 'acme/api' },
        issue: { number: 142, title: 'Add v2 endpoint', html_url: 'https://github.com/acme/api/issues/142' },
        comment: { body: '@hive add a postinstall script', html_url: 'https://github.com/acme/api/issues/142#issuecomment-9' },
      },
    };
    // No association at all → rejected (the token alone is not authorization).
    assert.deepEqual(configMatchesEvent(config, base), { ok: false, reason: 'comment_author_untrusted', kind: 'comment' });
    // A drive-by external commenter → rejected.
    const external = { ...base, payload: { ...base.payload, comment: { ...base.payload.comment, author_association: 'NONE' } } };
    assert.equal(configMatchesEvent(config, external).ok, false);
    // A repo collaborator → allowed.
    const collaborator = { ...base, payload: { ...base.payload, comment: { ...base.payload.comment, author_association: 'COLLABORATOR' } } };
    assert.deepEqual(configMatchesEvent(config, collaborator), { ok: true, kind: 'comment' });
  });

  it('creates exactly one traced run per source colony and event id', () => {
    const sourceId = createColony('Implement ready issues', 'llama3', 'development_team', {
      repoPath: '/tmp/acme-api',
      triggerConfig: {
        webhook_id: 'wh-trigger-1',
        repo: 'acme/api',
        event_types: ['issue'],
        comment_token: '@hive',
      },
    });
    created.push(sourceId);

    const first = processWebhookEvent(issueEvent, { startRun: false });
    const second = processWebhookEvent(issueEvent, { startRun: false });
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);

    const triggeredId = first[0].colony_id;
    created.push(triggeredId);
    const triggered = getColony(triggeredId);
    assert.equal(triggered.trigger.event_id, issueEvent.id);
    assert.equal(triggered.trigger.event_type, 'issues/opened');
    assert.equal(triggered.trigger.source_url, 'https://github.com/acme/api/issues/142');
    assert.equal(triggered.board_card.number, 142);
    assert.equal(triggered.board_card.repo, 'acme/api');

    const processed = db.prepare('SELECT COUNT(*) AS n FROM colony_trigger_events WHERE colony_id=? AND event_id=?')
      .get(sourceId, issueEvent.id);
    assert.equal(processed.n, 1);
  });
});
