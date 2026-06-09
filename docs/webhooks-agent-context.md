# Webhooks: Controlling Agent Context

When a webhook event triggers an AI agent, you usually don't want to hand the agent the entire raw payload. A single GitHub push or Stripe event can be tens of kilobytes of JSON, most of which the agent never needs. Dumping all of it into the agent's context wastes tokens, slows the run, and buries the few fields that actually matter.

Hive solves this with **context projection**: you define which fields each webhook should extract, and the agent receives only that distilled set — while the full raw payload stays one tool call away whenever the agent needs more.

## How it works

Every incoming event is still stored in full, exactly as before. Nothing is discarded. Projection happens at the moment you take action on an event:

1. An event arrives and is saved raw to the event inbox.
2. When you (or an automation) trigger a pipeline on that event, Hive builds a **context envelope** — the fields you mapped, plus a handle back to the stored event.
3. The agent starts with that lean envelope as its input.
4. If the agent finds it needs a field that wasn't included, it calls the `get_webhook_event` tool to fetch the complete raw payload on demand.

The principle is *store raw, project at the boundary*: you never lose data, you only narrow what crosses into the agent's working context.

## Defining context fields

Open a webhook in the Webhooks page and use the **Agent Context Fields** section. Each row maps a label to a path into the payload:

| Field | Meaning |
|-------|---------|
| **Label** | The name the field will have in the agent's context (e.g. `repo`). |
| **Payload path** | A dot-notation path into the raw payload (e.g. `repository.full_name`). Array elements use numeric segments (e.g. `commits.0.id`). |
| **Event type** | Optional. If set, the mapping only applies to events of that type. Leave blank to apply to all events. |

For example, mapping a GitHub push down to three fields:

```
repo      →  repository.full_name
author    →  pusher.name
message   →  head_commit.message
```

A push payload that was 20+ KB becomes:

```json
{
  "context": { "repo": "acme/api", "author": "cris", "message": "fix race condition" },
  "_event_id": "abc123",
  "_event_type": "push",
  "_projected": true
}
```

### Per-event-type mappings

A single webhook often receives several event types (a GitHub webhook might deliver `push`, `issues`, and `pull_request`). Set the **Event type** column to project each one differently. Mappings with no event type apply to every event, so you can mix shared fields with type-specific ones:

```
repo      →  repository.full_name        (all events)
commit    →  head_commit.id              (push only)
issue     →  issue.number                (issues only)
```

### Fallback behavior

If no fields are mapped for an incoming event's type, Hive falls back to sending the **full raw payload** (with `_projected: false`). Existing webhooks therefore keep working unchanged until you add a spec — projection is opt-in per webhook.

## How the agent uses it

The context envelope the agent receives has a consistent shape:

| Key | Meaning |
|-----|---------|
| `context` | The distilled fields you mapped (or the full payload, on fallback). |
| `_event_id` | The id of the stored raw event — pass this to `get_webhook_event`. |
| `_event_type` | The event type. |
| `_projected` | `true` if the context was distilled, `false` if it's the full raw payload. |

### The `get_webhook_event` tool

Agents with the **Agent Tools** group enabled get a `get_webhook_event` tool — the escape hatch back to the complete data:

| Parameter | Type | Description |
|-----------|------|-------------|
| `event_id` | string (required) | The `_event_id` from the context envelope. |
| `include_headers` | boolean (optional) | Also return the original request headers. Defaults to `false`. |

It returns the full parsed `payload`, the `event_type`, and (if requested) the `headers`. The agent should call it only when the distilled context is missing something it genuinely needs — otherwise the context stays lean.

### The Webhook → Triage template

The Pipelines page includes a **Webhook → Triage** template wired for this flow. Its single step has the `agent_tools` group enabled and a prompt that explains the envelope shape and instructs the agent to work from `context` first, fetching raw data via `get_webhook_event` only when necessary. It's the fastest way to point an agent at a webhook correctly.

> If you build a pipeline by hand rather than from this template, include the same guidance in your first step's prompt — the agent only knows the `_event_id` is available and what `get_webhook_event` is for if you tell it.

## Reference

- **API**: `GET /api/webhooks/:id/events/:eventId/projected` returns the envelope for a single event. `context_spec` is accepted and returned on webhook create/update.
- **Storage**: the field map is stored as JSON in the `context_spec` column on the `webhooks` table. Raw events remain in `webhook_events` untouched.
