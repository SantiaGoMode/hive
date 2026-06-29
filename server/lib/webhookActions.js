const path = require('path');
const os = require('os');
const db = require('../db');
const { readAgent } = require('./agentParser');
const { runAgentOnce } = require('./agentTools');
const { runPipelineById } = require('./pipelineRunner');
const { buildEnvelope } = require('./webhookProjection');
const { getOllamaUrl } = require('./ollamaUrl');
const { logSwallowed } = require('./logSwallowed');

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function serializeActions(actions) {
  return JSON.stringify(normalizeActions(actions));
}

function normalizeActions(actions) {
  return parseJsonArray(actions)
    .map((action) => {
      const type = action.target_type === 'agent' ? 'agent' : 'pipeline';
      return {
        id: action.id || newId(),
        label: String(action.label || '').trim(),
        enabled: action.enabled !== false,
        event_type: String(action.event_type || '').trim(),
        target_type: type,
        pipeline_id: type === 'pipeline' ? String(action.pipeline_id || '').trim() : '',
        agent_id: type === 'agent' ? String(action.agent_id || '').trim() : '',
        prompt: String(action.prompt || '{input}'),
      };
    })
    .filter(action => action.target_type === 'pipeline' ? action.pipeline_id : action.agent_id);
}

function actionMatchesEvent(action, eventType) {
  if (!action.enabled) return false;
  if (!action.event_type) return true;
  return action.event_type === eventType;
}

function renderTemplate(template, envelope) {
  const input = JSON.stringify(envelope, null, 2);
  const context = JSON.stringify(envelope.context ?? {}, null, 2);
  return String(template || '{input}')
    .replace(/\{input\}/g, input)
    .replace(/\{context\}/g, context)
    .replace(/\{event_type\}/g, envelope._event_type || '')
    .replace(/\{event_id\}/g, envelope._event_id || '');
}

function runRecordForAction(webhook, event, action, input) {
  const runId = newId();
  const targetId = action.target_type === 'pipeline' ? action.pipeline_id : action.agent_id;
  db.prepare(`
    INSERT INTO webhook_action_runs
      (id, webhook_id, event_id, action_id, action_label, action_type, target_id, input, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    webhook.id,
    event.id,
    action.id,
    action.label || '',
    action.target_type,
    targetId,
    input,
    'running',
  );
  return runId;
}

async function executeActionRun(runId, action, input) {
  try {
    if (action.target_type === 'pipeline') {
      const result = await runPipelineById(action.pipeline_id, input);
      db.prepare(`
        UPDATE webhook_action_runs
        SET status='done', output=?, pipeline_run_id=?, completed_at=unixepoch()
        WHERE id=?
      `).run(result.final_output || '', result.run_id || null, runId);
      return;
    }

    const agent = readAgent(action.agent_id);
    if (!agent) throw new Error('Agent not found');
    if (!agent.model) throw new Error('No model configured');
    const ollamaUrl = getOllamaUrl();
    const hivePath = process.env.HIVE_HOME || path.join(os.homedir(), '.hive');
    const output = await runAgentOnce(agent, [{ role: 'user', content: input }], ollamaUrl, 0, null, hivePath);
    db.prepare(`
      UPDATE webhook_action_runs
      SET status='done', output=?, completed_at=unixepoch()
      WHERE id=?
    `).run(output || '', runId);
  } catch (e) {
    db.prepare(`
      UPDATE webhook_action_runs
      SET status='error', error=?, completed_at=unixepoch()
      WHERE id=?
    `).run(e.message || String(e), runId);
  }
}

function triggerWebhookActions(webhook, event) {
  const actions = normalizeActions(webhook.actions_config);
  if (actions.length === 0) return [];

  let contextSpec = [];
  try { contextSpec = JSON.parse(webhook.context_spec || '[]'); } catch (e) { logSwallowed('webhookActions:parseContextSpec', e, { webhookId: webhook.id }); }
  const envelope = buildEnvelope(contextSpec, event);
  const matched = actions.filter(action => actionMatchesEvent(action, event.event_type));
  const runIds = [];

  for (const action of matched) {
    const input = renderTemplate(action.prompt, envelope);
    const runId = runRecordForAction(webhook, event, action, input);
    runIds.push(runId);
    setImmediate(() => executeActionRun(runId, action, input));
  }

  return runIds;
}

module.exports = {
  actionMatchesEvent,
  executeActionRun,
  normalizeActions,
  renderTemplate,
  serializeActions,
  triggerWebhookActions,
};
