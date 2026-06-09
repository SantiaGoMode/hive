# Webhook Context Projection — Design Plan

## Goal

When a webhook event triggers an AI agent (via "Take Action" → pipeline), pass the agent
only a **distilled set of fields** it needs instead of the entire raw payload. Keep the full
raw payload accessible **on demand** so the agent can fetch it when the projection isn't enough.

Approach chosen: **deterministic field-map** projection per webhook + a `get_webhook_event`
tool as the raw-data escape hatch.

---

## Current flow (where the bloat is)

1. External service POSTs to `POST /api/webhooks/incoming/:id` (`server/routes/webhooks.js`).
2. The entire `req.body` is stored raw in `webhook_events.payload` (JSON text), plus `headers`.
3. UI (`client/src/pages/WebhooksPage.jsx`) lists events and shows the raw payload.
4. **"Take Action"** in `ActionModal` does:
   ```js
   setActionPayload(JSON.stringify(evt.payload, null, 2));   // entire raw payload
   ...
   <RunModal ... initialInput={payloadStr} />
   ```
5. `RunModal` (`PipelinesPage.jsx:456`) seeds `input` with that string and POSTs it to
   `POST /api/pipelines/:id/run` (`server/routes/pipelines.js:110`), where `{input}` is
   substituted into the first step's prompt template.

So the **full raw JSON** becomes the agent's `{input}` every time. That's the bloat point.

> Design principle: **store raw, project at the action boundary.** We never lose data — we
> only narrow what crosses into the agent's context. The raw row stays in `webhook_events`.

---

## The three changes

### 1. Schema — store a context spec per webhook

Add an additive, nullable column to the `webhooks` table (migrations are additive-only in
`server/db.js`, consistent with the existing `try { db.exec("ALTER TABLE ...") } catch {}` block):

```js
try { db.exec("ALTER TABLE webhooks ADD COLUMN context_spec TEXT DEFAULT '[]'"); } catch {}
```

`context_spec` is a JSON array of field mappings. Each entry:

```json
{ "label": "repo",    "path": "repository.full_name" }
{ "label": "author",  "path": "pusher.name" }
{ "label": "message", "path": "head_commit.message" }
```

Optional refinements (decide during build, not required for v1):
- `event_type` on each mapping, so one webhook that receives many event types can project
  each type differently. If omitted, the mapping applies to all event types.
- A global fallback behavior when no spec matches (see §4).

`path` uses simple dot-notation into the parsed payload (array indexing optional, e.g.
`commits.0.id`). A ~15-line resolver covers this — no new dependency needed.

### 2. Projection logic + envelope at the action boundary

Add a pure helper, e.g. `server/lib/webhookProjection.js`:

```js
// resolve("a.b.0.c", obj) -> nested value or undefined
function resolvePath(path, obj) { /* split on '.', walk, guard nullish */ }

// Given a spec array + raw payload, build the distilled object.
function project(spec, payload) {
  const out = {};
  for (const { label, path } of spec) out[label] = resolvePath(path, payload);
  return out;
}
```

The **envelope** the agent receives keeps the event handle so it can fetch raw later:

```json
{
  "context": { "repo": "acme/api", "author": "cris", "message": "fix race condition" },
  "_event_id": "abc123",
  "_event_type": "push"
}
```

Two places this can be applied — pick one:

- **(A) Project on read (recommended for v1).** Leave the incoming handler untouched; project
  in the UI / when action is taken. Lowest risk, no change to ingestion, lets you tweak the
  spec and re-run old events with the new projection.
- **(B) Project on ingest.** Compute and store a `projected` column alongside `payload` in the
  incoming handler. Slightly faster at action time, but old events won't benefit from spec
  edits and you store data twice. Defer unless ingestion-time filtering is needed.

Wiring for (A): in `WebhooksPage.jsx`'s `ActionModal`, replace
`JSON.stringify(evt.payload, null, 2)` with
`JSON.stringify(buildEnvelope(activeWebhook.context_spec, evt), null, 2)`.
If `context_spec` is empty, fall back to current behavior (full payload) so nothing breaks.

> Server-side option: expose `GET /api/webhooks/:id/events/:eventId/projected` that returns the
> envelope, so projection logic lives in one place (server) and the client just calls it. Cleaner
> than duplicating the resolver in JS on the client. Recommended.

### 3. `get_webhook_event` tool — the raw-data escape hatch

Add to `TOOLS` in `server/lib/agentTools.js` (same shape as `read_shared` at line 678),
group `agent_tools`:

```js
get_webhook_event: {
  group: 'agent_tools',
  definition: {
    type: 'function',
    function: {
      name: 'get_webhook_event',
      description: 'Fetch the FULL raw payload of a webhook event by its id. The initial ' +
        'context you were given is a distilled subset; call this only when you need fields ' +
        'that were not included. Pass the _event_id from your input.',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'The _event_id from the provided context envelope' },
          include_headers: { type: 'boolean', description: 'Also return request headers (default false)' },
        },
        required: ['event_id'],
      },
    },
  },
  async handler({ event_id, include_headers = false }) {
    const row = db.prepare('SELECT payload, headers, event_type FROM webhook_events WHERE id = ?').get(event_id);
    if (!row) return { error: `No webhook event with id ${event_id}` };
    const out = { event_type: row.event_type, payload: JSON.parse(row.payload) };
    if (include_headers) out.headers = JSON.parse(row.headers);
    return out;
  },
},
```

`db` is already required at the top of `agentTools.js`, so no new imports. The tool is picked
up automatically by `getToolDefinitions` / `executeTool` since it lives in the `TOOLS` map under
an enabled group. Any agent with `agent_tools` enabled gets it.

---

## How the pieces fit together at runtime

```
Event arrives ──> stored raw in webhook_events.payload   (unchanged)
                                   │
User clicks "Take Action"          │
                                   ▼
        project(context_spec, payload) ──> { context, _event_id, _event_type }
                                   │
                                   ▼
        RunModal initialInput = envelope  ──>  pipeline step {input}
                                   │
        Agent reads small context. If it needs more:
                                   ▼
        get_webhook_event(_event_id)  ──>  full raw payload  (on demand only)
```

Token cost up front drops from the full payload (often tens of KB) to a handful of fields.
The raw data is one tool call away, never gone.

---

## Touch points (file-by-file)

| File | Change |
|------|--------|
| `server/db.js` | Add `context_spec` column migration (additive). |
| `server/lib/webhookProjection.js` | **New.** `resolvePath`, `project`, `buildEnvelope`. |
| `server/routes/webhooks.js` | Accept/return `context_spec` in POST/PUT; optionally add `GET .../events/:eventId/projected`. |
| `server/lib/agentTools.js` | Add `get_webhook_event` tool to `TOOLS`. |
| `client/src/pages/WebhooksPage.jsx` | Add field-map editor UI to `WebhookEditor`; change `ActionModal` to pass the envelope. |
| `client/src/lib/api.js` | If using server-side projection endpoint, add the call. |
| `server/tests/webhooks.test.js` | Tests: projection correctness, empty-spec fallback, `get_webhook_event` hit/miss. |

---

## Decisions still open (for the build phase)

1. **Project on read vs on ingest** — recommend on read (option A) for v1.
2. **Per-event-type specs** — needed if a single webhook receives mixed event types
   (e.g. GitHub `push` vs `issues`). Recommend adding the optional `event_type` field now;
   it's cheap and avoids a later migration.
3. **Empty-spec fallback** — when no spec is defined, fall back to full payload (preserves
   today's behavior) vs. a generic top-level-keys-only projection. Recommend full-payload
   fallback so existing webhooks keep working unchanged until a spec is added.
4. **Where projection lives** — client-side resolver (simple) vs server endpoint (one source
   of truth, reusable by schedules/automation later). Recommend server endpoint.

---

## Verification plan

- Unit test `project()` against a real GitHub push payload fixture; assert only mapped fields
  survive and dot-paths resolve (including a missing path → `undefined`/omitted).
- Test empty `context_spec` → envelope falls back to full payload.
- Test `get_webhook_event` returns parsed payload for a known id and `{ error }` for a missing id.
- Manual: create a webhook with a spec, POST a fat payload to the incoming endpoint, "Take
  Action", confirm the agent's `{input}` shows only the distilled context, then confirm the
  agent can call `get_webhook_event` to retrieve the rest.
