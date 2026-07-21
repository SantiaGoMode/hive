const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const { buildEnvelope } = require('../lib/webhookProjection');
const { serializeActions, triggerWebhookActions } = require('../lib/webhookActions');
const { processWebhookEvent } = require('../lib/colonyTriggers');
const { routeWebhookEvent } = require('../lib/workRouter');
const { resolveSecret, parseEnvRef } = require('../lib/secrets');
const { createWebhookRateLimiter, isLocalRequest, timingSafeEqualString } = require('../lib/auth');
const { validateBody, createWebhookSchema, updateWebhookSchema } = require('../lib/validate');

function newId() {
  return crypto.randomUUID();
}

const webhookRateLimiter = createWebhookRateLimiter();
const SAFE_EVENT_HEADERS = new Set([
  'content-type', 'user-agent', 'x-github-delivery', 'x-github-event',
  'x-gitlab-event', 'x-gitlab-event-uuid',
]);

function sanitizedEventHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([name]) => SAFE_EVENT_HEADERS.has(String(name).toLowerCase()))
    .map(([name, value]) => [String(name).toLowerCase(), value]));
}

function validatedEnabledSecret({ secret, enabled }) {
  if (!enabled) return null;
  if (!secret || isMasked(secret)) {
    return 'An enabled webhook requires a secret or env:NAME reference';
  }
  return null;
}

// Normalize a context spec (array or JSON string) into a JSON string for storage.
function serializeSpec(spec) {
  if (spec == null) return '[]';
  if (typeof spec === 'string') {
    try { JSON.parse(spec); return spec; } catch { return '[]'; }
  }
  try { return JSON.stringify(spec); } catch { return '[]'; }
}

// Secret handling mirrors routes/config.js: env:NAME refs are returned
// verbatim (the reference is not sensitive), raw values are masked, and a
// masked value sent back on update means "keep the stored secret".
function maskSecret(value) {
  if (!value) return '';
  if (parseEnvRef(value)) return value;
  return `••••••••${value.slice(-4)}`;
}

function isMasked(value) {
  return typeof value === 'string' && value.includes('•');
}

function publicWebhook(row) {
  return row ? { ...row, secret: maskSecret(row.secret) } : row;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all();
  res.json(rows.map(publicWebhook));
});

router.post('/', validateBody(createWebhookSchema), (req, res) => {
  const { name, description = '', secret = '', enabled = 1, context_spec, actions_config } = req.body;
  const secretError = validatedEnabledSecret({ secret, enabled: !!enabled });
  if (secretError) return res.status(400).json({ error: secretError });
  const id = newId();
  db.prepare('INSERT INTO webhooks (id, name, description, secret, enabled, context_spec, actions_config) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, description, isMasked(secret) ? '' : secret, enabled ? 1 : 0, serializeSpec(context_spec), serializeActions(actions_config));
  const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
  res.status(201).json(publicWebhook(row));
});

router.put('/:id', validateBody(updateWebhookSchema), (req, res) => {
  const { name, description, secret, enabled, context_spec, actions_config } = req.body;
  const existing = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Webhook not found' });
  const nextSecret = secret === undefined || isMasked(secret) ? existing.secret : secret;
  const nextEnabled = enabled !== undefined ? !!enabled : !!existing.enabled;
  const secretError = validatedEnabledSecret({ secret: nextSecret, enabled: nextEnabled });
  if (secretError) return res.status(400).json({ error: secretError });

  db.prepare('UPDATE webhooks SET name=?, description=?, secret=?, enabled=?, context_spec=?, actions_config=?, updated_at=unixepoch() WHERE id=?')
    .run(
      name ?? existing.name,
      description ?? existing.description,
      nextSecret,
      nextEnabled ? 1 : 0,
      context_spec !== undefined ? serializeSpec(context_spec) : (existing.context_spec ?? '[]'),
      actions_config !== undefined ? serializeActions(actions_config) : (existing.actions_config ?? '[]'),
      req.params.id
    );
  const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
  res.json(publicWebhook(row));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM webhook_events WHERE webhook_id = ?').run(req.params.id);
  db.prepare('DELETE FROM webhook_action_runs WHERE webhook_id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Events ────────────────────────────────────────────────────────────────────

router.get('/:id/events', (req, res) => {
  const type = req.query.type;
  let rows;
  if (type) {
    rows = db.prepare('SELECT * FROM webhook_events WHERE webhook_id = ? AND event_type = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(req.params.id, type);
  } else {
    rows = db.prepare('SELECT * FROM webhook_events WHERE webhook_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(req.params.id);
  }
  // Parse JSON columns before sending
  res.json(rows.map(r => ({
    ...r,
    payload: JSON.parse(r.payload),
    headers: JSON.parse(r.headers)
  })));
});

router.get('/:id/action-runs', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM webhook_action_runs
    WHERE webhook_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `).all(req.params.id);
  res.json(rows);
});

// Return the distilled context envelope for a single event, built from the
// webhook's context_spec. This is what gets passed to the agent as {input} —
// only the mapped fields plus the event handle, not the full raw payload.
router.get('/:id/events/:eventId/projected', (req, res) => {
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  const evt = db.prepare('SELECT * FROM webhook_events WHERE id = ? AND webhook_id = ?')
    .get(req.params.eventId, req.params.id);
  if (!evt) return res.status(404).json({ error: 'Event not found' });

  let spec = [];
  try { spec = JSON.parse(webhook.context_spec || '[]'); } catch { spec = []; }

  const envelope = buildEnvelope(spec, {
    id: evt.id,
    event_type: evt.event_type,
    payload: JSON.parse(evt.payload),
  });
  res.json(envelope);
});

router.delete('/:id/events', (req, res) => {
  db.prepare('DELETE FROM webhook_events WHERE webhook_id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Incoming Webhook Handler ──────────────────────────────────────────────────

router.post('/incoming/:id', webhookRateLimiter, (req, res) => {
  const webhookId = req.params.id;
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId);
  
  if (!webhook) {
    return res.status(404).json({ error: 'Webhook endpoint not found' });
  }
  if (!webhook.enabled) {
    return res.status(403).json({ error: 'Webhook endpoint is disabled' });
  }

  // Incoming routes intentionally bypass the Hive UI token. The webhook's
  // own secret is therefore mandatory for every enabled endpoint.
  if (!webhook.secret) {
    return res.status(isLocalRequest(req) ? 409 : 401).json({
      error: 'Webhook is unsafe and has been disabled until a secret is configured',
    });
  }

  // 1. Signature Verification
  if (webhook.secret) {
    const secret = resolveSecret(webhook.secret);
    if (!secret) {
      return res.status(401).json({ error: 'Webhook secret reference is not available' });
    }
    let isValid = false;
    // Check GitHub HMAC-SHA256 signature
    const ghSignature = req.headers['x-hub-signature-256'];
    if (ghSignature && req.rawBody) {
      const hmac = crypto.createHmac('sha256', secret);
      const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
      // timingSafeEqualString length-checks first — crypto.timingSafeEqual
      // throws on attacker-controlled length mismatches.
      if (timingSafeEqualString(digest, String(ghSignature))) {
        isValid = true;
      }
    }
    // Check custom static headers — constant-time, never ===
    if (!isValid && typeof req.headers['authorization'] === 'string'
      && timingSafeEqualString(req.headers['authorization'], `Bearer ${secret}`)) isValid = true;
    if (!isValid && typeof req.headers['x-api-key'] === 'string'
      && timingSafeEqualString(req.headers['x-api-key'], secret)) isValid = true;
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid or missing signature/secret' });
    }
  }

  // 2. Extract Event Type
  let eventType = 'webhook';
  if (req.headers['x-github-event']) {
    eventType = req.headers['x-github-event'];
  } else if (req.body && req.body.type && typeof req.body.type === 'string') {
    eventType = req.body.type;
  }

  // 3. Save to database
  const eventId = req.headers['x-github-delivery'] ? String(req.headers['x-github-delivery']) : newId();
  const safeHeaders = sanitizedEventHeaders(req.headers);
  const insert = db.prepare('INSERT OR IGNORE INTO webhook_events (id, webhook_id, event_type, payload, headers) VALUES (?, ?, ?, ?, ?)')
    .run(
      eventId,
      webhook.id,
      eventType,
      JSON.stringify(req.body || {}),
      JSON.stringify(safeHeaders)
    );

  const event = {
    id: eventId,
    webhook_id: webhook.id,
    event_type: eventType,
    payload: req.body || {},
    headers: safeHeaders,
  };

  if (insert.changes > 0) {
    triggerWebhookActions(webhook, event);
    setImmediate(() => {
      try { processWebhookEvent(event); } catch (e) { console.warn('[hive] colony trigger evaluation failed:', e.message); }
      // Intake matchmaking (colonies-first): independently of any per-run
      // trigger config, propose the event to the best-matching colony's work
      // queue (suggestion-only — never starts a run).
      try { routeWebhookEvent(event); } catch (e) { console.warn('[hive] work-queue intake failed:', e.message); }
    });
  }

  // 4. Respond instantly
  res.status(202).json({ success: true, message: insert.changes > 0 ? 'Event accepted' : 'Event already accepted', event_id: eventId, duplicate: insert.changes === 0 });
});

module.exports = router;
module.exports.sanitizedEventHeaders = sanitizedEventHeaders;
