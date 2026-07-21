const db = require('../db');
const colonyRunService = require('./colonyRunService');
const workItems = require('./colonyWorkItems');

const DEFAULT_COMMENT_TOKEN = '@hive';


function parseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeTriggerConfig(input) {
  if (!input || typeof input !== 'object') return null;
  const webhookId = String(input.webhook_id || '').trim();
  const repo = String(input.repo || '').trim();
  const eventTypes = Array.isArray(input.event_types)
    ? [...new Set(input.event_types.map(v => String(v || '').trim().toLowerCase()).filter(Boolean))]
    : [];
  const commentToken = String(input.comment_token || DEFAULT_COMMENT_TOKEN).trim() || DEFAULT_COMMENT_TOKEN;
  return {
    webhook_id: webhookId || null,
    repo: repo || null,
    event_types: eventTypes,
    comment_token: commentToken,
    paused: !!input.paused,
  };
}

function repoFromPayload(payload) {
  return payload?.repository?.full_name
    || payload?.organization?.login && payload?.repository?.name && `${payload.organization.login}/${payload.repository.name}`
    || null;
}

function eventTypeWithAction(eventType, payload) {
  const action = payload?.action ? String(payload.action).toLowerCase() : '';
  return action ? `${String(eventType || 'webhook').toLowerCase()}/${action}` : String(eventType || 'webhook').toLowerCase();
}

function classifyEvent(eventType, payload) {
  const type = String(eventType || '').toLowerCase();
  const action = String(payload?.action || '').toLowerCase();
  if ((type === 'issues' || type === 'issue') && (!action || ['opened', 'reopened'].includes(action))) return 'issue';
  if (type === 'issue_comment' || type === 'commit_comment' || type === 'pull_request_review_comment' || type.endsWith('_comment')) return 'comment';
  if (type.includes('project') || type === 'projects_v2_item' || type === 'project_card') return 'task';
  return type;
}

function commentBody(payload) {
  return payload?.comment?.body
    || payload?.review?.body
    || payload?.discussion?.body
    || '';
}

// GitHub stamps every comment/review with the author's relationship to the repo.
// Only these may trigger a run: a comment trigger otherwise lets ANY external
// user launch an autonomous, push-capable colony on the owner's repo, with the
// owner's token and a writable mount. The comment token ("@hive") is public and
// is NOT an authorization signal — anyone can type it.
const TRUSTED_COMMENT_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function commentAuthorAssociation(payload) {
  return String(
    payload?.comment?.author_association
    || payload?.review?.author_association
    || payload?.discussion?.author_association
    || '',
  ).toUpperCase();
}

function sourceUrl(payload) {
  return payload?.comment?.html_url
    || payload?.issue?.html_url
    || payload?.pull_request?.html_url
    || payload?.project_card?.content_url
    || payload?.projects_v2_item?.content_url
    || payload?.sender?.html_url
    || null;
}

function boardCardFromPayload(payload, eventKind) {
  const item = payload?.issue || payload?.pull_request || payload?.project_card || payload?.projects_v2_item || null;
  const repo = repoFromPayload(payload);
  if (!item && !sourceUrl(payload)) return null;
  return {
    id: item?.node_id || item?.id || `${eventKind}:${sourceUrl(payload) || Date.now()}`,
    provider: 'github',
    repo: repo || undefined,
    type: payload?.pull_request ? 'pull_request' : payload?.issue ? 'issue' : eventKind,
    number: item?.number || payload?.issue?.number || payload?.pull_request?.number || null,
    title: item?.title || payload?.comment?.body?.split('\n')[0]?.slice(0, 120) || `${eventKind} event`,
    status: 'ready',
    status_label: payload?.action || '',
    labels: Array.isArray(item?.labels) ? item.labels.map(l => l.name || l).filter(Boolean) : [],
    assignees: Array.isArray(item?.assignees) ? item.assignees.map(a => a.login || a).filter(Boolean) : [],
    source: 'webhook',
    url: sourceUrl(payload),
    description: item?.body || payload?.comment?.body || '',
  };
}

function buildTriggeredGoal(sourceColony, event, payload, eventKind) {
  const fullType = eventTypeWithAction(event.event_type, payload);
  const card = boardCardFromPayload(payload, eventKind);
  const parts = [
    '[Triggered Colony Event]',
    `Event: ${fullType}`,
    `Repository: ${repoFromPayload(payload) || 'unknown'}`,
    sourceUrl(payload) ? `Source: ${sourceUrl(payload)}` : '',
    card?.number ? `Work item: #${card.number} ${card.title || ''}`.trim() : '',
    '',
    'Event payload summary:',
    payload?.issue?.title ? `Issue: ${payload.issue.title}` : '',
    payload?.pull_request?.title ? `Pull request: ${payload.pull_request.title}` : '',
    payload?.comment?.body ? `Comment: ${payload.comment.body}` : '',
    '',
    'Original colony direction:',
    sourceColony.goal,
  ];
  return parts.filter(part => part !== '').join('\n');
}

function configMatchesEvent(config, event) {
  const payload = event.payload || {};
  if (!config || config.paused) return { ok: false, reason: 'paused' };
  if (config.webhook_id && config.webhook_id !== event.webhook_id) return { ok: false, reason: 'webhook_mismatch' };

  const repo = repoFromPayload(payload);
  if (config.repo && repo && config.repo.toLowerCase() !== repo.toLowerCase()) return { ok: false, reason: 'repo_mismatch' };
  if (config.repo && !repo) return { ok: false, reason: 'repo_missing' };

  const kind = classifyEvent(event.event_type, payload);
  if (!config.event_types?.includes(kind) && !config.event_types?.includes(eventTypeWithAction(event.event_type, payload))) {
    return { ok: false, reason: 'event_type_mismatch', kind };
  }

  if (kind === 'comment') {
    const token = config.comment_token || DEFAULT_COMMENT_TOKEN;
    if (token && !String(commentBody(payload)).toLowerCase().includes(token.toLowerCase())) {
      return { ok: false, reason: 'comment_token_missing', kind };
    }
    // Authorization gate: the token above is public, so it can't be trusted.
    // Only repo owners/members/collaborators may launch a run from a comment.
    if (!TRUSTED_COMMENT_ASSOCIATIONS.has(commentAuthorAssociation(payload))) {
      return { ok: false, reason: 'comment_author_untrusted', kind };
    }
  }

  return { ok: true, kind };
}

function insertProcessedEvent(sourceColonyId, event, sourceUrlValue) {
  try {
    db.prepare(`
      INSERT INTO colony_trigger_events (colony_id, event_id, webhook_id, event_type, source_url)
      VALUES (?, ?, ?, ?, ?)
    `).run(sourceColonyId, event.id, event.webhook_id, eventTypeWithAction(event.event_type, event.payload || {}), sourceUrlValue || null);
    return true;
  } catch (e) {
    if (String(e.code || '').includes('SQLITE_CONSTRAINT')) return false;
    throw e;
  }
}

function processWebhookEvent(event, opts = {}) {
  const startRun = opts.startRun !== false;
  const candidates = db.prepare(`
    SELECT * FROM colonies
    WHERE trigger_config IS NOT NULL
    ORDER BY created_at ASC
  `).all();
  const triggered = [];

  for (const row of candidates) {
    const config = normalizeTriggerConfig(parseJson(row.trigger_config));
    const match = configMatchesEvent(config, event);
    if (!match.ok) continue;

    const url = sourceUrl(event.payload || {});
    if (!insertProcessedEvent(row.id, event, url)) continue;

    const boardCard = boardCardFromPayload(event.payload || {}, match.kind);
    const modelPlan = parseJson(row.model_plan);
    const trigger = {
      event_id: event.id,
      event_type: eventTypeWithAction(event.event_type, event.payload || {}),
      source_url: url,
      source_colony_id: row.id,
      webhook_id: event.webhook_id,
    };
    const goal = buildTriggeredGoal(row, event, event.payload || {}, match.kind);
    let triggeredColonyId;
    try {
      triggeredColonyId = colonyRunService.createRun({
      goal, model: row.model, recipeId: row.recipe_id,
      repoPath: row.repo_path || null,
      boardCard,
      cloudEnabled: !!row.cloud_enabled,
      githubReview: !!row.github_review,
      githubPublish: !!row.github_publish,
      modelPlan,
      trigger,
      // Triggered follow-up runs stay inside the same colony as their source run.
      teamId: row.team_id || null,
      }, { enqueue: startRun });
    } catch (error) {
      // A team with an active durable job receives triggered work in its normal
      // inbox rather than creating a parallel competing run.
      if (row.team_id) {
        const item = workItems.createWorkItem({
          teamId: row.team_id, source: 'webhook', sourceRef: `${event.webhook_id}:${event.id}`,
          title: boardCard?.title || `Triggered ${match.kind} event`, direction: goal,
          boardCard, status: 'queued', matchReason: 'queued because the colony is busy',
        });
        triggered.push({ source_colony_id: row.id, queued_work_item_id: item.id, trigger });
        continue;
      }
      throw error;
    }

    db.prepare('UPDATE colony_trigger_events SET triggered_colony_id=? WHERE colony_id=? AND event_id=?')
      .run(triggeredColonyId, row.id, event.id);
    triggered.push({ source_colony_id: row.id, colony_id: triggeredColonyId, trigger });

    if (startRun) {
      try { require('./rosterBus').notifyRoster('run_started', { run_id: triggeredColonyId }); } catch { /* roster is best-effort */ }
    }
  }

  return triggered;
}

module.exports = {
  DEFAULT_COMMENT_TOKEN,
  normalizeTriggerConfig,
  repoFromPayload,
  classifyEvent,
  configMatchesEvent,
  processWebhookEvent,
  boardCardFromPayload,
  eventTypeWithAction,
};
