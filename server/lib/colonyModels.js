// ── Colony model planning ─────────────────────────────────────────────────────
// Per-role model assignment for a colony. The operator proposes a plan (which
// model each role should use) based on the goal, the recipe's roles, and the
// allowed pool — the user can override it before launch. When cloud is disabled,
// only local Ollama models are allowed.

const { parseModel } = require('./providers/adapters');

// Roles that primarily write/inspect code — they get the strongest coding model.
const CODING_ROLES = new Set(['software_developer', 'qa_engineer', 'devops_engineer']);
const REASONING_MODES = new Set(['auto', 'on', 'off']);

function normalizeReasoningMode(mode) {
  const v = String(mode || 'auto').toLowerCase();
  return REASONING_MODES.has(v) ? v : 'auto';
}

function isCloudModel(modelId) {
  return parseModel(modelId).provider !== 'ollama';
}

// Gate a single model id against the colony's cloud setting.
function gateModel(modelId, cloudEnabled) {
  if (!cloudEnabled && isCloudModel(modelId)) {
    return { ok: false, error: `Model "${modelId}" is a cloud model but this colony has cloud models disabled. Enable cloud models or choose a local Ollama model.` };
  }
  return { ok: true };
}

// Heuristic strength score for ranking models without an extra LLM call.
// Cloud flagships rank highest; locally, bigger params + coder variants win.
function scoreModel(entry) {
  const id = (entry?.id || entry?.name || '').toLowerCase();
  const provider = entry?.provider || parseModel(id).provider;
  if (provider !== 'ollama') {
    if (/opus/.test(id)) return 100;
    if (/sonnet/.test(id)) return 92;
    if (/gpt-5/.test(id)) return 90;
    if (/gemini-2\.5-pro/.test(id)) return 88;
    if (/gpt-4o(?!-mini)/.test(id)) return 82;
    if (/gemini.*flash|gpt-4o-mini|haiku/.test(id)) return 70;
    return 75; // unknown cloud model — still strong
  }
  // Local: derive a size from the tag (e.g. "qwen2.5-coder:14b" → 14).
  const sizeMatch = id.match(/(\d+(?:\.\d+)?)\s*b\b/);
  const size = sizeMatch ? parseFloat(sizeMatch[1]) : 7;
  let score = Math.min(size, 70); // cap so a huge local never outranks a flagship cloud
  if (/coder|code/.test(id)) score += 4;
  if (/qwen|llama3\.1|llama-3\.1|mistral-nemo|mistral-small/.test(id)) score += 2;
  return score;
}

function isCoderModel(entry) {
  const id = (entry?.id || entry?.name || '').toLowerCase();
  return /coder|code|sonnet|opus|gpt|qwen/.test(id);
}

// Flatten a grouped pool ({ollama:[],anthropic:[],...}) → array of model entries,
// filtered to local-only when cloud is disabled.
function flattenPool(grouped, cloudEnabled) {
  const all = [];
  for (const list of Object.values(grouped || {})) {
    if (Array.isArray(list)) all.push(...list);
  }
  return all.filter(e => cloudEnabled || (e.provider || parseModel(e.id).provider) === 'ollama');
}

// Pick the best model id from a list of entries by score (optionally requiring
// a coder-ish model). Returns null when the list is empty.
function bestModel(entries, { coder = false } = {}) {
  let pool = entries;
  if (coder) {
    const coders = entries.filter(isCoderModel);
    if (coders.length) pool = coders;
  }
  if (!pool.length) return null;
  return [...pool].sort((a, b) => scoreModel(b) - scoreModel(a))[0].id;
}

// Propose a per-role model plan. `recipe` is a colony recipe (with .roles), or
// null. `grouped` is the provider-grouped pool from listAllModels(). Returns
// { operator, <role_key>: modelId, ... }. `fallback` is used when the pool is
// empty (e.g. nothing installed) so we never produce an empty plan.
function proposeModelPlan(recipe, grouped, { cloudEnabled = false, fallback = 'llama3.1:8b' } = {}) {
  const pool = flattenPool(grouped, cloudEnabled);

  // When the gateway is on (cloud), prefer its capability aliases so each role
  // gets automatic multi-provider failover instead of a single concrete model.
  const aliasIds = new Set((grouped?.gateway || []).map(e => e.id));
  const useAliases = cloudEnabled && aliasIds.size > 0;
  const alias = (name, fb) => (useAliases && aliasIds.has(`gateway/${name}`)) ? `gateway/${name}` : fb;

  const strongest = alias('hive-smart', bestModel(pool) || fallback);
  const coding = alias('hive-coding', bestModel(pool, { coder: true }) || strongest);
  // General-purpose: prefer a mid model, else the strongest.
  const general = alias('hive-smart', bestModel(pool) || strongest);

  const plan = { operator: strongest };
  const roles = (recipe && Array.isArray(recipe.roles)) ? recipe.roles : [];
  for (const role of roles) {
    plan[role.key] = CODING_ROLES.has(role.key) ? coding : general;
  }
  return plan;
}

// Validate/repair an operator-proposed plan against the pool + cloud gate.
// Any role whose chosen model isn't in the allowed pool (or violates the cloud
// setting) is filled from the heuristic plan, so the result is always launchable.
function validatePlan(proposed, recipe, grouped, { cloudEnabled = false } = {}) {
  const heuristic = proposeModelPlan(recipe, grouped, { cloudEnabled });
  const allowed = new Set(flattenPool(grouped, cloudEnabled).map(e => e.id));
  const out = {};
  const keys = ['operator', ...((recipe && recipe.roles) || []).map(r => r.key)];
  for (const key of keys) {
    const pick = proposed && proposed[key];
    out[key] = (pick && allowed.has(pick) && gateModel(pick, cloudEnabled).ok) ? pick : heuristic[key];
  }
  return out;
}

// Operator-reasoned plan. A capable model (the strongest in the allowed pool)
// reasons about which model each role should use, choosing only from the pool.
// Falls back to the heuristic plan on any error/timeout/invalid output, and
// repairs any out-of-pool picks — so it never blocks or returns junk.
async function proposeModelPlanLLM(recipe, grouped, { cloudEnabled = false, goal = '', providers = null, timeoutMs = 30000 } = {}) {
  const heuristic = proposeModelPlan(recipe, grouped, { cloudEnabled });
  const pool = flattenPool(grouped, cloudEnabled);
  const prov = providers || require('./providers');
  const reasoner = bestModel(pool);
  if (!pool.length || !reasoner) return { model_plan: heuristic, source: 'heuristic' };

  const roleLines = ((recipe && recipe.roles) || [])
    .map(r => `- ${r.key} (${r.role}): ${CODING_ROLES.has(r.key) ? 'writes/inspects code' : 'analysis/planning/writing'}`)
    .join('\n');
  const allowedIds = pool.map(e => e.id).join(', ');
  const sys = 'You are a Colony Operator provisioning a software team. Choose the most cost-effective capable model for each role. Coding roles benefit from strong coding models; analysis/planning roles can use lighter models. If "gateway/" capability aliases (e.g. gateway/hive-smart, gateway/hive-coding, gateway/hive-cheap) are in the allowed list, PREFER them — they automatically fail over across providers if one is unavailable. Respond with ONLY a JSON object mapping each role key (and "operator") to a model id chosen strictly from the allowed list. No prose, no code fences.';
  const user = `Mission: ${goal || '(unspecified)'}\nCloud models ${cloudEnabled ? 'ENABLED' : 'DISABLED (local only)'}.\nRoles:\n${roleLines}\n\nAllowed model ids (choose only from these): ${allowedIds}\n\nReturn JSON like {"operator":"<id>","<role_key>":"<id>", ...}.`;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let raw;
    try {
      raw = await prov.generateText(reasoner, [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ], { signal: ac.signal, temperature: 0.2, metadata: { source: 'model_planning' } });
    } finally {
      clearTimeout(timer);
    }
    const jsonStr = (raw.match(/\{[\s\S]*\}/) || [null])[0];
    if (!jsonStr) return { model_plan: heuristic, source: 'heuristic' };
    const parsed = JSON.parse(jsonStr);
    const plan = validatePlan(parsed, recipe, grouped, { cloudEnabled });
    return { model_plan: plan, source: 'operator', reasoner };
  } catch {
    return { model_plan: heuristic, source: 'heuristic' };
  }
}

// Resolve the model a given role should run with: explicit plan entry → operator
// model → colony fallback model.
function resolveRoleModel(modelPlan, roleKey, fallbackModel) {
  if (modelPlan && typeof modelPlan === 'object') {
    if (roleKey && modelPlan[roleKey]) return modelPlan[roleKey];
    if (modelPlan.operator) return modelPlan.operator;
  }
  return fallbackModel;
}

function shouldEnableWorkerReasoning({ mode = 'auto', recipe = null, goal = '' } = {}) {
  const normalized = normalizeReasoningMode(mode);
  if (normalized === 'on') return true;
  if (normalized === 'off') return false;
  const text = `${goal || ''} ${recipe?.name || ''}`.toLowerCase();
  const hasCodingRoles = Array.isArray(recipe?.roles) && recipe.roles.some(r => CODING_ROLES.has(r.key));
  return hasCodingRoles || /architecture|debug|investigate|migrate|refactor|security|test failure|failing test|multi[-\s]?step|complex|root cause/.test(text);
}

// Operator reasoning decision, made once at run start. The operator itself
// ALWAYS reasons; this decides which worker agents get reasoning, per role:
// coding roles always reason; analysis/planning roles reason only when the
// mission text signals complexity. Returns a per-role map plus a default for
// agents created mid-run (custom_auto path).
function decideRoleReasoning({ recipe = null, goal = '' } = {}) {
  const text = String(goal || '').toLowerCase();
  const complex = /architecture|debug|investigate|migrate|refactor|security|test failure|failing test|multi[-\s]?step|complex|root cause/.test(text);
  const byRole = {};
  const roles = Array.isArray(recipe?.roles) ? recipe.roles : [];
  for (const role of roles) {
    byRole[role.key] = CODING_ROLES.has(role.key) || complex;
  }
  const hasCodingRoles = roles.some(r => CODING_ROLES.has(r.key));
  return {
    operator: true,
    by_role: byRole,
    default: hasCodingRoles || complex,
    rationale: complex
      ? 'mission text signals complexity — all roles reason'
      : 'coding roles reason; analysis/planning roles run lean',
  };
}

// Validate a whole plan against the cloud setting. Returns the first violation.
function gatePlan(modelPlan, cloudEnabled) {
  if (!modelPlan || typeof modelPlan !== 'object') return { ok: true };
  for (const modelId of Object.values(modelPlan)) {
    const g = gateModel(modelId, cloudEnabled);
    if (!g.ok) return g;
  }
  return { ok: true };
}

module.exports = {
  CODING_ROLES,
  normalizeReasoningMode,
  shouldEnableWorkerReasoning,
  decideRoleReasoning,
  isCloudModel,
  gateModel,
  gatePlan,
  scoreModel,
  flattenPool,
  bestModel,
  proposeModelPlan,
  proposeModelPlanLLM,
  validatePlan,
  resolveRoleModel,
};
