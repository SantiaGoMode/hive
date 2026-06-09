// ── Webhook context projection ────────────────────────────────────────────────
// Narrows a raw webhook payload down to the small set of fields an agent actually
// needs, based on a per-webhook context spec. The raw event is never discarded —
// it stays in webhook_events and can be fetched on demand via the get_webhook_event
// tool using the _event_id carried in the envelope.

// Resolve a dot-notation path into a nested object/array.
//   resolvePath('repository.full_name', payload)
//   resolvePath('commits.0.id', payload)
// Returns undefined if any segment is missing.
function resolvePath(path, obj) {
  if (!path || obj == null) return undefined;
  const segments = String(path).split('.');
  let cur = obj;
  for (const seg of segments) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// A spec is an array of { label, path, event_type? }.
// Mappings with an event_type only apply when it matches the event's type;
// mappings without one apply to every event type.
function specForEventType(spec, eventType) {
  if (!Array.isArray(spec)) return [];
  return spec.filter(m => m && m.path && m.label && (!m.event_type || m.event_type === eventType));
}

// Build the distilled context object from a spec + raw payload.
function project(spec, payload, eventType) {
  const mappings = specForEventType(spec, eventType);
  const out = {};
  for (const { label, path } of mappings) {
    out[label] = resolvePath(path, payload);
  }
  return out;
}

// Build the envelope passed to the agent as {input}.
// - If the spec yields at least one mapped field, return the distilled context
//   plus the event handle so the agent can fetch raw data on demand.
// - If no spec applies (empty result), fall back to the full raw payload so
//   existing webhooks keep working unchanged until a spec is added.
function buildEnvelope(spec, event) {
  const payload = event.payload || {};
  const eventType = event.event_type;
  const mappings = specForEventType(spec, eventType);

  if (mappings.length === 0) {
    // Full-payload fallback (no spec defined for this event type).
    return {
      context: payload,
      _event_id: event.id,
      _event_type: eventType,
      _projected: false,
    };
  }

  return {
    context: project(spec, payload, eventType),
    _event_id: event.id,
    _event_type: eventType,
    _projected: true,
  };
}

module.exports = { resolvePath, specForEventType, project, buildEnvelope };
