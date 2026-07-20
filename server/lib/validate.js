// Request-body validation (zod). Routes that write to the DB validate against
// an explicit schema instead of spreading req.body into SQL. Unknown keys are
// stripped (not rejected) so older clients that echo server-generated fields
// back (id, workspace, created_at, …) keep working; known fields get type and
// bounds checks with a consistent 400 shape.

const { z } = require('zod');

// Express middleware factory: parse req.body with `schema`; on success replace
// req.body with the parsed (stripped, coerced) value, on failure respond
// 400 { error, details: [{ path, message }] }.
function describeIssue(issue) {
  const path = issue.path.join('.') || '(root)';
  // "expected string, received undefined" → the field is simply missing.
  if (issue.code === 'invalid_type' && String(issue.message).includes('received undefined')) {
    return `${path} is required`;
  }
  return `${path}: ${issue.message}`;
}

function validateBody(schema) {
  return function validate(req, res, next) {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const details = result.error.issues.map(describeIssue);
      return res.status(400).json({ error: details.join('; '), details });
    }
    req.body = result.data;
    next();
  };
}

// ── Agents ────────────────────────────────────────────────────────────────────

const agentFields = {
  name: z.string().trim().min(1).max(200),
  persona_name: z.string().max(200),
  persona_role: z.string().max(200),
  model: z.string().max(200),
  description: z.string().max(4000),
  avatar_color: z.string().max(32),
  temperature: z.coerce.number().min(0).max(2),
  max_tokens: z.coerce.number().int().min(1).max(1_000_000),
  context_length: z.coerce.number().int().min(1).max(10_000_000),
  tools: z.array(z.string().max(200)).max(100),
  system_prompt: z.string().max(200_000),
  ephemeral: z.union([z.boolean(), z.number().int().min(0).max(1)]),
  reasoning: z.union([z.boolean(), z.number().int().min(0).max(1)]),
  gateway_budget_usd: z.union([z.coerce.number().min(0), z.literal(''), z.null()]),
};

const createAgentSchema = z.object({
  ...Object.fromEntries(Object.entries(agentFields).map(([k, v]) => [k, k === 'name' ? v : v.optional()])),
});

const updateAgentSchema = z.object(
  Object.fromEntries(Object.entries(agentFields).map(([k, v]) => [k, v.optional()])),
);

// ── Pipelines ─────────────────────────────────────────────────────────────────

const pipelineStepSchema = z.object({
  // A missing/empty agent_id is a legal draft state; the runner rejects it at
  // run time with a clear error.
  agent_id: z.string().max(200).optional(),
  label: z.string().max(500).optional(),
  prompt: z.string().max(200_000).optional(),
  tools: z.array(z.string().max(200)).max(100).optional(),
});

const createPipelineSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
  steps: z.array(pipelineStepSchema).max(100).optional(),
});

const updatePipelineSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  steps: z.array(pipelineStepSchema).max(100).optional(),
});

// ── Webhooks ──────────────────────────────────────────────────────────────────
// context_spec / actions_config used to be silently coerced to [] when
// malformed; now a malformed value is a 400 instead of quiet data loss.

// Accept a real array or a JSON string encoding one (both were accepted
// before); anything else is a 400.
const jsonArrayOf = (inner) => z.preprocess((value) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}, inner);

const contextSpecSchema = jsonArrayOf(z.array(z.record(z.string(), z.unknown())).max(200));
const actionsConfigSchema = jsonArrayOf(z.array(z.record(z.string(), z.unknown())).max(100));

const createWebhookSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
  secret: z.string().trim().max(1000).optional(),
  enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  context_spec: contextSpecSchema.optional(),
  actions_config: actionsConfigSchema.optional(),
});

const updateWebhookSchema = createWebhookSchema.partial();

module.exports = {
  validateBody,
  createAgentSchema,
  updateAgentSchema,
  pipelineStepSchema,
  createPipelineSchema,
  updatePipelineSchema,
  createWebhookSchema,
  updateWebhookSchema,
};
