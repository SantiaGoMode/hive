const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const {
  actionMatchesEvent,
  normalizeActions,
  renderTemplate,
  triggerWebhookActions,
} = require('../lib/webhookActions');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describe('webhook automatic actions', () => {
  it('normalizes pipeline and agent actions while preserving disabled rules', () => {
    const actions = normalizeActions([
      { label: 'Issues flow', event_type: 'issues', target_type: 'pipeline', pipeline_id: 'pipe-1', prompt: '{context}' },
      { label: 'Disabled', enabled: false, target_type: 'agent', agent_id: 'agent-1' },
      { label: 'Invalid', target_type: 'pipeline', pipeline_id: '' },
    ]);

    assert.equal(actions.length, 2);
    assert.equal(actions[0].target_type, 'pipeline');
    assert.equal(actions[0].pipeline_id, 'pipe-1');
    assert.equal(actions[1].enabled, false);
    assert.equal(actions[1].target_type, 'agent');
  });

  it('matches blank event types to all events and exact event types only otherwise', () => {
    assert.equal(actionMatchesEvent({ enabled: true, event_type: '' }, 'issues'), true);
    assert.equal(actionMatchesEvent({ enabled: true, event_type: 'issues' }, 'issues'), true);
    assert.equal(actionMatchesEvent({ enabled: true, event_type: 'push' }, 'issues'), false);
    assert.equal(actionMatchesEvent({ enabled: false, event_type: 'issues' }, 'issues'), false);
  });

  it('renders prompt variables from the projected event envelope', () => {
    const out = renderTemplate('type={event_type} id={event_id}\n{context}', {
      context: { repo: 'acme/api', issue: 42 },
      _event_id: 'evt-1',
      _event_type: 'issues',
      _projected: true,
    });

    assert.match(out, /type=issues id=evt-1/);
    assert.match(out, /"repo": "acme\/api"/);
  });

  it('creates an action run for matching incoming events', async () => {
    const webhook = {
      id: `wh_${Date.now()}`,
      context_spec: JSON.stringify([{ label: 'issue', path: 'issue.number' }]),
      actions_config: JSON.stringify([
        {
          id: 'coding-flow',
          label: 'Coding flow for issues',
          enabled: true,
          event_type: 'issues',
          target_type: 'pipeline',
          pipeline_id: 'missing-pipeline',
          prompt: 'Handle issue {context}',
        },
      ]),
    };
    const event = {
      id: `evt_${Date.now()}`,
      event_type: 'issues',
      payload: { issue: { number: 42 } },
    };

    const runIds = triggerWebhookActions(webhook, event);
    assert.equal(runIds.length, 1);

    const queued = db.prepare('SELECT * FROM webhook_action_runs WHERE id=?').get(runIds[0]);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.action_label, 'Coding flow for issues');
    assert.equal(queued.action_type, 'pipeline');
    assert.match(queued.input, /"issue": 42/);

    await sleep(25);
    const finished = db.prepare('SELECT * FROM webhook_action_runs WHERE id=?').get(runIds[0]);
    assert.equal(finished.status, 'error');
    assert.match(finished.error, /Pipeline not found/);
  });
});
