const db = require('../db');
const { v4 } = require('./uuid');
const { listColonyRecipes, getColonyRecipe } = require('./colonyRecipes');
const { readAgent, writeAgent } = require('./agentParser');
const { logSwallowed } = require('./logSwallowed');

function safeParse(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(v => String(v || '').trim()).filter(Boolean))];
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

function profileRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    recipe_id: row.recipe_id,
    role_key: row.role_key,
    display_name: row.display_name,
    role: row.role || '',
    personality: row.personality || '',
    system_prompt: row.system_prompt || '',
    skills: safeParse(row.skills, []),
    tools: safeParse(row.tools, []),
    model_preference: row.model_preference || '',
    assigned_agent_id: row.assigned_agent_id || '',
    memory: row.memory || '',
    avatar_color: row.avatar_color || '#3b82f6',
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Drift flags: whether the user customized these away from the seeded
    // recipe defaults. Customized values are preserved by the seed drift-sync;
    // pristine ones auto-follow recipe improvements. Surfacing this in the UI
    // is the lesson of the stale-profile incident — an invisible override
    // silently pinned every role to weeks-old prompts and tools.
    prompt_customized: (row.system_prompt || '') !== (row.seeded_prompt || ''),
    tools_customized: (row.tools || '[]') !== (row.seeded_tools || '[]'),
  };
}

function suggestionRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    profile_id: row.profile_id,
    colony_id: row.colony_id || null,
    evidence_type: row.evidence_type,
    evidence_ref: row.evidence_ref,
    target_field: row.target_field,
    proposed_value: row.proposed_value,
    rationale: row.rationale || '',
    source: row.source || 'operator',
    status: row.status,
    applied_value: row.applied_value || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Default personalities for the seeded personas — voice and working style,
// distinct per role. Users can edit or clear these per profile afterwards.
const ROLE_PERSONALITIES = {
  business_analyst: 'Warm but precise. Asks "why" before "what" and restates vague asks as concrete requirements. Allergic to ambiguity; loves a crisp acceptance criterion. Keeps messages short and always ends with the one thing she still needs to know.',
  project_manager: 'Organized and calm, lives by the plan. Communicates in short, direct sentences; surfaces blockers early instead of sugar-coating. Gently pulls tangents back on topic and always names an owner and a next step.',
  ui_ux_designer: 'User-first and a little playful. Challenges assumptions with "what does the user feel here?" Prefers sketching two options over debating one. Honest about trade-offs between pretty and shippable.',
  // No quotable canned sentences in personalities — small models copy them
  // verbatim as their entire final answer ("I don't know yet — let me check"
  // became the developer's complete turn summary in multiple runs).
  software_developer: 'Pragmatic, dry humor. Prefers working code over long discussion; verifies instead of guessing. Flags risky changes and tech debt as he sees them, without drama. Always ends a turn by stating concretely what was built, what was verified, and what remains.',
  qa_engineer: 'Detail-obsessed and proudly skeptical. Treats every claim as unverified until there\'s evidence. Celebrates found bugs ("good catch territory") and asks for repro steps, not opinions. Friendly, but won\'t sign off on vibes.',
  devops_engineer: 'Calm under pressure, thinks in failure modes. Automation-first: if it happened twice, script it. Speaks in short, concrete updates and always mentions rollback plans before risky changes.',
  researcher: 'Endlessly curious, cites sources by habit, and clearly separates "the data says" from "I suspect". Comfortable saying the evidence is thin.',
  source_critic: 'Contrarian but fair. Stress-tests every claim, asks who benefits from a source being true, and never blocks without proposing what proof would change his mind.',
  synthesizer: 'Big-picture connector. Pulls threads from everyone\'s work into one clear narrative, ruthlessly trims filler, and flags where the story still has holes.',
};

function seedStaffProfiles() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO staff_profiles
      (id, recipe_id, role_key, display_name, role, system_prompt, personality, skills, tools, avatar_color, seeded_prompt, seeded_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Drift repair: profiles whose prompt/tools still equal what the seeder wrote
  // (i.e. never user-edited) follow the CURRENT recipe definition. Without this,
  // profiles seeded months ago silently overrode every recipe improvement —
  // workers ran with stale prompts and stale tool grants.
  const syncPrompt = db.prepare(`
    UPDATE staff_profiles SET system_prompt=?, seeded_prompt=?, updated_at=unixepoch()
    WHERE recipe_id=? AND role_key=? AND system_prompt = seeded_prompt AND system_prompt != ?
  `);
  const syncTools = db.prepare(`
    UPDATE staff_profiles SET tools=?, seeded_tools=?, updated_at=unixepoch()
    WHERE recipe_id=? AND role_key=? AND tools = seeded_tools AND tools != ?
  `);
  for (const summary of listColonyRecipes()) {
    const recipe = getColonyRecipe(summary.id);
    if (!Array.isArray(recipe.roles)) continue;
    for (const role of recipe.roles) {
      const prompt = role.prompt || '';
      const tools = JSON.stringify(role.tools || []);
      const personality = role.personality || ROLE_PERSONALITIES[role.key] || '';
      const skills = JSON.stringify(
        Array.isArray(role.skills) && role.skills.length
          ? role.skills
          : [role.role || role.name].filter(Boolean),
      );
      insert.run(
        v4(),
        recipe.id,
        role.key,
        role.agent_name || role.name,
        role.role || role.name,
        prompt,
        personality,
        skills,
        tools,
        role.color || '#3b82f6',
        prompt,
        tools,
      );
      try {
        syncPrompt.run(prompt, prompt, recipe.id, role.key, prompt);
        syncTools.run(tools, tools, recipe.id, role.key, tools);
      } catch (e) { logSwallowed('staffDirectory:syncSeededProfile', e, { role: role.key }); }
    }
  }

  // One-time backfill (v2): profiles seeded before roles carried a persona
  // (the expanded catalog initially seeded with empty personality and
  // title-only skills) get the role's personality where still EMPTY and the
  // role's skill assignments where skills are still the old seeded default.
  // One-time by flag, like the v1 backfill below — users may intentionally
  // clear a personality or trim skills afterwards, and that must stick.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='staff_personas_seeded_v2'").get();
    if (!done) {
      const updPersonality = db.prepare("UPDATE staff_profiles SET personality=?, updated_at=unixepoch() WHERE recipe_id=? AND role_key=? AND personality=''");
      const updSkills = db.prepare("UPDATE staff_profiles SET skills=?, updated_at=unixepoch() WHERE recipe_id=? AND role_key=? AND skills IN (?, '[]') AND skills != ?");
      for (const summary of listColonyRecipes()) {
        const recipe = getColonyRecipe(summary.id);
        for (const role of recipe.roles || []) {
          const personality = role.personality || ROLE_PERSONALITIES[role.key] || '';
          if (personality) updPersonality.run(personality, recipe.id, role.key);
          if (Array.isArray(role.skills) && role.skills.length) {
            const skills = JSON.stringify(role.skills);
            const legacyDefault = JSON.stringify([role.role || role.name].filter(Boolean));
            updSkills.run(skills, recipe.id, role.key, legacyDefault, skills);
          }
        }
      }
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('staff_personas_seeded_v2', '1')").run();
    }
  } catch (e) { logSwallowed('staffDirectory:seedPersonasV2', e); }

  // One-time backfill: existing profiles seeded before personalities existed
  // get their role's default personality (only where still empty, and only
  // once — users may intentionally clear a personality afterwards).
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='staff_personalities_seeded_v1'").get();
    if (!done) {
      const upd = db.prepare("UPDATE staff_profiles SET personality=?, updated_at=unixepoch() WHERE role_key=? AND personality=''");
      for (const [roleKey, personality] of Object.entries(ROLE_PERSONALITIES)) {
        upd.run(personality, roleKey);
      }
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('staff_personalities_seeded_v1', '1')").run();
    }
  } catch (e) { logSwallowed('staffDirectory:seedPersonalities', e); }
}

// Create a custom staff profile (beyond the recipe-seeded ones). Custom
// profiles become candidates when the operator staffs preset roles — matching
// is by role_key/role title (see selectProfileForRole).
function createProfile(data = {}) {
  const displayName = String(data.display_name || '').trim();
  const role = String(data.role || '').trim();
  if (!displayName) throw new Error('display_name is required');
  if (!role) throw new Error('role is required');
  const recipeId = String(data.recipe_id || 'custom').trim() || 'custom';
  let roleKey = String(data.role_key || '').trim() || norm(role).replace(/\s+/g, '_');
  // (recipe_id, role_key) is unique — suffix until free.
  let candidate = roleKey;
  for (let i = 2; db.prepare('SELECT 1 FROM staff_profiles WHERE recipe_id=? AND role_key=?').get(recipeId, candidate); i++) {
    candidate = `${roleKey}_${i}`;
  }
  roleKey = candidate;
  const id = v4();
  db.prepare(`
    INSERT INTO staff_profiles
      (id, recipe_id, role_key, display_name, role, system_prompt, personality, skills, tools, avatar_color, model_preference)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, recipeId, roleKey, displayName, role,
    String(data.system_prompt || ''),
    String(data.personality || ''),
    JSON.stringify(Array.isArray(data.skills) ? data.skills.map(String).filter(Boolean) : [role]),
    JSON.stringify(Array.isArray(data.tools) ? data.tools.map(String).filter(Boolean) : []),
    String(data.avatar_color || '#3b82f6'),
    String(data.model_preference || ''),
  );
  return getProfile(id);
}

// Delete a profile. Recipe-seeded roles cannot be deleted — seedStaffProfiles
// would just recreate them on the next read; only custom profiles go away.
function deleteProfile(id) {
  const profile = getProfile(id);
  if (!profile) return { ok: false, error: 'Staff profile not found' };
  try {
    const recipe = getColonyRecipe(profile.recipe_id);
    if (recipe.id === profile.recipe_id && Array.isArray(recipe.roles) && recipe.roles.some(r => r.key === profile.role_key)) {
      return { ok: false, error: 'This profile backs a team-preset role and cannot be deleted. Edit it instead.' };
    }
  } catch {} /* unknown recipe → custom profile, deletable */
  db.prepare('DELETE FROM staff_profiles WHERE id=?').run(id);
  return { ok: true };
}

// Append a short run note to a profile's durable memory, keeping it bounded.
const PROFILE_MEMORY_MAX_CHARS = 4000;
function appendProfileMemory(profileId, note) {
  const profile = getProfile(profileId);
  if (!profile || !note) return;
  let memory = `${profile.memory ? profile.memory.trimEnd() + '\n' : ''}${note}`;
  if (memory.length > PROFILE_MEMORY_MAX_CHARS) {
    // Trim whole lines from the top.
    const lines = memory.split('\n');
    while (lines.length > 1 && lines.join('\n').length > PROFILE_MEMORY_MAX_CHARS) lines.shift();
    memory = lines.join('\n');
  }
  db.prepare('UPDATE staff_profiles SET memory=?, updated_at=unixepoch() WHERE id=?').run(memory, profileId);
}

function listProfiles() {
  seedStaffProfiles();
  backfillAssignedAgents();
  return db.prepare('SELECT * FROM staff_profiles ORDER BY recipe_id, role_key').all().map(profileRowToJson);
}

function getProfile(id) {
  seedStaffProfiles();
  return profileRowToJson(db.prepare('SELECT * FROM staff_profiles WHERE id=?').get(id));
}

function getProfileByRole(recipeId, roleKey) {
  seedStaffProfiles();
  return profileRowToJson(db.prepare('SELECT * FROM staff_profiles WHERE recipe_id=? AND role_key=?').get(recipeId, roleKey));
}

function normalizeProfilePatch(data = {}) {
  const patch = {};
  for (const key of ['display_name', 'role', 'personality', 'system_prompt', 'model_preference', 'assigned_agent_id', 'memory', 'avatar_color']) {
    if (Object.prototype.hasOwnProperty.call(data, key)) patch[key] = String(data[key] ?? '');
  }
  if (Object.prototype.hasOwnProperty.call(data, 'skills')) {
    patch.skills = JSON.stringify(Array.isArray(data.skills) ? data.skills.map(String).filter(Boolean) : []);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'tools')) {
    patch.tools = JSON.stringify(Array.isArray(data.tools) ? data.tools.map(String).filter(Boolean) : []);
  }
  return patch;
}

function updateProfile(id, data) {
  const existing = getProfile(id);
  if (!existing) return null;
  const patch = normalizeProfilePatch(data);
  const keys = Object.keys(patch);
  if (!keys.length) return existing;
  const sets = keys.map(k => `${k}=?`).join(', ');
  db.prepare(`UPDATE staff_profiles SET ${sets}, updated_at=unixepoch() WHERE id=?`)
    .run(...keys.map(k => patch[k]), id);
  return getProfile(id);
}

// Prompt rendering for assigned skills lives in skillsBlock.js — shared with
// per-agent skills (systemPrompt.js) so the two features can't drift.
const { renderSkillsManifest } = require('./skillsBlock');

function splitMissionSuffix(systemPrompt) {
  const marker = '\n\n---\n[Colony Mission]';
  const idx = String(systemPrompt || '').indexOf(marker);
  if (idx === -1) return '';
  return String(systemPrompt).slice(idx);
}

// Operator staffing: pick the best staff member for a preset role based on the
// colony's requirements (name + description + run goal). Candidates are every
// profile whose role_key (or role title) matches the preset role, across
// recipes — scored on recipe fit, skill overlap with the requirements text,
// accumulated memory, and delivery track record. Falls back to the recipe's
// seeded profile when nothing scores higher.
function selectProfileForRole(recipeId, roleKey, requirements = '') {
  seedStaffProfiles();
  const all = listProfiles();
  const candidates = all.filter(p =>
    norm(p.role_key) === norm(roleKey)
    || roleMatchesProfile(p, roleKey));
  if (!candidates.length) return { profile: null, reason: 'no matching staff profile', candidates: 0 };

  const reqText = norm(requirements);
  const scored = candidates.map(p => {
    let score = 0;
    const why = [];
    if (p.recipe_id === recipeId) { score += 4; why.push('native to this team preset'); }
    if (roleMatchesProfile(p, roleKey)) { score += 4; why.push('role match'); }
    const skillHits = (p.skills || []).filter(s => {
      const tokens = norm(s).split(' ').filter(t => t.length > 3);
      return tokens.some(t => reqText.includes(t));
    });
    if (skillHits.length) { score += skillHits.length * 5; why.push(`skills match: ${skillHits.join(', ')}`); }
    if ((p.memory || '').trim()) { score += 2; why.push('has accumulated working memory'); }
    if (p.model_preference) { score += 1; }
    try {
      const m = profileMetrics(p);
      if (m.successful_handoffs > m.rejected_handoffs) { score += 2; why.push('strong handoff record'); }
    } catch (e) { logSwallowed('staffDirectory:profileMetrics', e, { profileId: p.id }); }
    return { p, score, why };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  return {
    profile: best.p,
    reason: best.why.join('; ') || 'only available candidate',
    candidates: candidates.length,
  };
}

function applyStaffProfilesToWorkerConfigs(recipeId, workerConfigs, modelPlan = null, opts = {}) {
  if (!Array.isArray(workerConfigs) || !recipeId) return workerConfigs;
  seedStaffProfiles();
  const requirements = String(opts.requirements || '');
  return workerConfigs.map(config => {
    if (!config.role_key) return config;
    let profile = null;
    let selection = null;
    if (requirements) {
      selection = selectProfileForRole(recipeId, config.role_key, requirements);
      profile = selection.profile;
    }
    if (!profile) profile = getProfileByRole(recipeId, config.role_key);
    if (!profile) return config;
    if (typeof opts.onSelect === 'function') {
      opts.onSelect({
        role_key: config.role_key,
        profile_id: profile.id,
        display_name: profile.display_name,
        reason: selection?.reason || 'recipe default',
        candidates: selection?.candidates || 1,
      });
    }

    const next = { ...config };
    if (profile.display_name) next.name = profile.display_name;
    next._staff_profile_id = profile.id;
    if (profile.role) next.persona_role = profile.role;
    if (profile.avatar_color) next.avatar_color = profile.avatar_color;
    // Union, never replace: the recipe's tool groups are the role's capability
    // architecture (handoff lives in protocol_worker; PM is file-only by
    // design). A profile may ADD tools but must not strip these — a stale
    // profile snapshot once removed every worker's handoff tool.
    if (profile.tools.length) next.tools = [...new Set([...(config.tools || []), ...profile.tools])];
    // Skills are now loaded on demand (manifest in the prompt + load_skill),
    // so any role with assigned skills needs the skill-loader tool group.
    if (profile.skills.length) next.tools = [...new Set([...(next.tools || config.tools || []), 'skills'])];
    if (profile.model_preference && !(modelPlan && modelPlan[config.role_key])) {
      next.model = profile.model_preference;
    }
    if (profile.system_prompt) {
      next.system_prompt = `${profile.system_prompt}${splitMissionSuffix(config.system_prompt)}`;
    }
    const extra = [];
    if (profile.personality.trim()) extra.push(`[Personality]\n${profile.personality.trim()}`);
    if (profile.skills.length) extra.push(`[Staff Skills]\n${renderSkillsManifest(profile.skills)}`);
    if (profile.memory.trim()) extra.push(`[Staff Memory]\n${profile.memory.trim()}`);
    if (extra.length) next.system_prompt += `\n\n---\n${extra.join('\n\n')}\n---`;
    return next;
  });
}

function staffPromptForAgent(profile, effective) {
  const basePrompt = profile.system_prompt || effective?.recipe_prompt || '';
  const extra = [];
  if (profile.personality.trim()) extra.push(`[Personality]\n${profile.personality.trim()}`);
  if (profile.skills.length) extra.push(`[Staff Skills]\n${renderSkillsManifest(profile.skills)}`);
  if (profile.memory.trim()) extra.push(`[Staff Memory]\n${profile.memory.trim()}`);
  return [
    basePrompt,
    extra.length ? `---\n${extra.join('\n\n')}\n---` : '',
  ].filter(Boolean).join('\n\n');
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function clampNumber(value, min, max, { int = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const clamped = Math.max(min, Math.min(max, n));
  return int ? Math.round(clamped) : clamped;
}

function runtimeAgentOverrides(overrides = {}) {
  const runtime = {};
  if (hasOwn(overrides, 'temperature')) {
    const temperature = clampNumber(overrides.temperature, 0, 2);
    if (temperature !== undefined) runtime.temperature = temperature;
  }
  if (hasOwn(overrides, 'max_tokens')) {
    const maxTokens = clampNumber(overrides.max_tokens, 1, 1_000_000, { int: true });
    if (maxTokens !== undefined) runtime.max_tokens = maxTokens;
  }
  if (hasOwn(overrides, 'context_length')) {
    const contextLength = clampNumber(overrides.context_length, 1, 10_000_000, { int: true });
    if (contextLength !== undefined) runtime.context_length = contextLength;
  }
  if (hasOwn(overrides, 'reasoning')) runtime.reasoning = !!overrides.reasoning;
  if (hasOwn(overrides, 'gateway_budget_usd')) {
    if (overrides.gateway_budget_usd == null || overrides.gateway_budget_usd === '') {
      runtime.gateway_budget_usd = null;
    } else {
      const budget = clampNumber(overrides.gateway_budget_usd, 0, Number.MAX_SAFE_INTEGER);
      if (budget !== undefined) runtime.gateway_budget_usd = budget;
    }
  }
  return runtime;
}

function agentConfigFromProfile(profile, overrides = {}, existing = null) {
  const effective = profileEffectiveConfig(profile.id);
  const effectiveTools = uniqueStrings((effective?.effective_tools || []).map(t => t.tool));
  const tools = effectiveTools.length ? effectiveTools : uniqueStrings(profile.tools);
  const model = String(overrides.model || '').trim()
    || profile.model_preference
    || existing?.model
    || '';
  return {
    name: profile.display_name || 'Staff Agent',
    persona_name: profile.display_name || '',
    persona_role: profile.role || '',
    model,
    description: `Staff profile: ${profile.display_name || profile.role || 'Staff'} (${profile.recipe_id}/${profile.role_key})`,
    avatar_color: profile.avatar_color || '#3b82f6',
    tools,
    system_prompt: staffPromptForAgent(profile, effective),
    ephemeral: false,
    ...runtimeAgentOverrides(overrides),
  };
}

function createAgentFromProfile(profileId, overrides = {}) {
  const profile = getProfile(profileId);
  if (!profile) return null;
  const existing = profile.assigned_agent_id ? readAgent(profile.assigned_agent_id) : null;
  const shouldUpdate = existing && !existing.ephemeral;
  const config = agentConfigFromProfile(profile, overrides, shouldUpdate ? existing : null);
  const agent = shouldUpdate
    ? writeAgent(existing.id, { ...existing, ...config })
    : writeAgent(null, config);
  linkAssignedAgent(profile.recipe_id, profile.role_key, agent.id, profile.id);
  return {
    created: !shouldUpdate,
    agent,
    profile: getProfile(profile.id),
  };
}

// What this profile ACTUALLY injects into a colony run: the current recipe
// baseline, whether the profile overrides it, and the effective tool union.
// Exists so overrides are visible in the UI — an invisible stale override once
// pinned every role to weeks-old prompts and tools with no way to notice.
function profileEffectiveConfig(id) {
  const profile = getProfile(id);
  if (!profile) return null;
  const recipe = getColonyRecipe(profile.recipe_id);
  const role = (recipe?.roles || []).find(r => r.key === profile.role_key) || null;
  const recipeTools = role?.tools || [];
  const profileTools = Array.isArray(profile.tools) ? profile.tools : [];
  const effectiveTools = [...new Set([...recipeTools, ...profileTools])].map(t => ({
    tool: t,
    source: recipeTools.includes(t) ? 'recipe' : 'profile',
  }));
  return {
    profile_id: profile.id,
    recipe_id: profile.recipe_id,
    role_key: profile.role_key,
    recipe_role_exists: !!role,
    recipe_prompt: role?.prompt || '',
    profile_prompt: profile.system_prompt || '',
    prompt_source: profile.prompt_customized && profile.system_prompt ? 'profile-custom' : 'recipe-default',
    prompt_customized: profile.prompt_customized,
    tools_customized: profile.tools_customized,
    effective_tools: effectiveTools,
  };
}

// Reset a profile's prompt and/or tools to the CURRENT recipe definition —
// the escape hatch for a customization that has drifted behind recipe
// improvements. Updates the seed snapshot too, so the profile becomes
// pristine again and auto-follows future recipe changes.
function resetProfileToRecipe(id, fields = ['system_prompt', 'tools']) {
  const profile = getProfile(id);
  if (!profile) return null;
  const recipe = getColonyRecipe(profile.recipe_id);
  const role = (recipe?.roles || []).find(r => r.key === profile.role_key);
  if (!role) throw new Error(`No recipe role "${profile.role_key}" in "${profile.recipe_id}" — custom staff have no recipe default to reset to.`);
  const wants = new Set(Array.isArray(fields) && fields.length ? fields : ['system_prompt', 'tools']);
  if (wants.has('system_prompt')) {
    db.prepare('UPDATE staff_profiles SET system_prompt=?, seeded_prompt=?, updated_at=unixepoch() WHERE id=?')
      .run(role.prompt || '', role.prompt || '', id);
  }
  if (wants.has('tools')) {
    const tools = JSON.stringify(role.tools || []);
    db.prepare('UPDATE staff_profiles SET tools=?, seeded_tools=?, updated_at=unixepoch() WHERE id=?')
      .run(tools, tools, id);
  }
  return getProfile(id);
}

function insertSuggestion({ profileId, colonyId = null, evidenceType, evidenceRef, targetField, proposedValue, rationale, source = 'operator' }) {
  if (!profileId || !evidenceType || !evidenceRef || !targetField || !proposedValue) return null;
  const id = v4();
  db.prepare(`
    INSERT OR IGNORE INTO staff_operator_suggestions
      (id, profile_id, colony_id, evidence_type, evidence_ref, target_field, proposed_value, rationale, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, profileId, colonyId, evidenceType, String(evidenceRef), targetField, proposedValue, rationale || '', source);
  return db.prepare(`
    SELECT * FROM staff_operator_suggestions
    WHERE profile_id=? AND evidence_type=? AND evidence_ref=? AND target_field=?
  `).get(profileId, evidenceType, String(evidenceRef), targetField);
}

function roleMatchesProfile(profile, value) {
  const n = norm(value);
  return n && (n === norm(profile.role_key) || n === norm(profile.role) || n === norm(profile.display_name));
}

function syncSuggestionsFromEvidence() {
  const profiles = listProfiles();
  const profileByRole = new Map(profiles.map(p => [p.role_key, p]));
  const inserted = [];

  const colonies = db.prepare('SELECT id, deliverable, log FROM colonies ORDER BY created_at DESC LIMIT 100').all();
  for (const colony of colonies) {
    const deliverable = safeParse(colony.deliverable, null);
    for (const [i, w] of (deliverable?.workarounds || []).entries()) {
      const target = profiles.find(p => roleMatchesProfile(p, `${w.issue || ''} ${w.recommendation || ''}`))
        || profiles.find(p => p.role_key === 'project_manager')
        || profiles[0];
      if (!target) continue;
      inserted.push(insertSuggestion({
        profileId: target.id,
        colonyId: colony.id,
        evidenceType: 'workaround_report',
        evidenceRef: `${colony.id}:workaround:${i}`,
        targetField: 'memory',
        proposedValue: `${target.memory || ''}${target.memory ? '\n' : ''}- Improvement evidence: ${w.recommendation || w.issue}`.trim(),
        rationale: [w.issue, w.impact].filter(Boolean).join(' '),
      }));
    }

    const log = safeParse(colony.log, []);
    for (const entry of log) {
      if (entry.kind === 'tool_result' && entry.result?.error && entry.agent) {
        const target = profiles.find(p => roleMatchesProfile(p, entry.agent));
        if (!target) continue;
        inserted.push(insertSuggestion({
          profileId: target.id,
          colonyId: colony.id,
          evidenceType: 'tool_error',
          evidenceRef: `${colony.id}:log:${entry.seq || entry.ts || entry.tool}`,
          targetField: 'memory',
          proposedValue: `${target.memory || ''}${target.memory ? '\n' : ''}- Tool issue to remember: ${entry.tool} failed with ${entry.result.error}`.trim(),
          rationale: `Tool failure observed in colony log: ${entry.tool}`,
        }));
      }
    }
  }

  const blockers = db.prepare(`
    SELECT id, colony_id, agent, content, entry_type FROM colony_blackboard
    WHERE entry_type IN ('blocker', 'assistance', 'message')
    ORDER BY id DESC LIMIT 300
  `).all();
  for (const entry of blockers) {
    const target = profiles.find(p => roleMatchesProfile(p, entry.agent));
    if (!target) continue;
    const isUserComment = /^USER COMMENT/i.test(entry.content || '');
    if (entry.entry_type !== 'blocker' && !isUserComment) continue;
    inserted.push(insertSuggestion({
      profileId: target.id,
      colonyId: entry.colony_id,
      evidenceType: isUserComment ? 'user_comment' : 'blackboard_blocker',
      evidenceRef: String(entry.id),
      targetField: 'memory',
      proposedValue: `${target.memory || ''}${target.memory ? '\n' : ''}- ${isUserComment ? 'User comment' : 'Blocker'}: ${entry.content}`.trim(),
      rationale: `Evidence from colony blackboard ${entry.id}`,
    }));
  }

  const handoffs = db.prepare(`
    SELECT * FROM colony_handoffs
    WHERE status='rejected' OR protocol_status!='ok'
    ORDER BY created_at DESC LIMIT 200
  `).all();
  for (const handoff of handoffs) {
    const target = profileByRole.get(handoff.from_agent);
    if (!target) continue;
    inserted.push(insertSuggestion({
      profileId: target.id,
      colonyId: handoff.colony_id,
      evidenceType: 'handoff_failure',
      evidenceRef: handoff.id,
      targetField: 'system_prompt',
      proposedValue: `${target.system_prompt}\n\nWhen handing off, verify upstream preconditions and use the handoff tool only for the next valid role in the protocol flow.`,
      rationale: `Rejected or invalid handoff ${handoff.from_agent}->${handoff.to_agent}`,
    }));
  }

  return inserted.filter(Boolean).map(suggestionRowToJson);
}

function listSuggestions(profileId = null) {
  syncSuggestionsFromEvidence();
  const rows = profileId
    ? db.prepare('SELECT * FROM staff_operator_suggestions WHERE profile_id=? ORDER BY created_at DESC').all(profileId)
    : db.prepare('SELECT * FROM staff_operator_suggestions ORDER BY created_at DESC').all();
  return rows.map(suggestionRowToJson);
}

function applySuggestion(id, proposedValue = undefined) {
  const row = db.prepare('SELECT * FROM staff_operator_suggestions WHERE id=?').get(id);
  if (!row) return null;
  const profile = getProfile(row.profile_id);
  if (!profile) return null;
  const value = proposedValue !== undefined ? String(proposedValue) : row.proposed_value;
  updateProfile(profile.id, { [row.target_field]: value });
  db.prepare("UPDATE staff_operator_suggestions SET status='applied', applied_value=?, updated_at=unixepoch() WHERE id=?")
    .run(value, id);
  return suggestionRowToJson(db.prepare('SELECT * FROM staff_operator_suggestions WHERE id=?').get(id));
}

function dismissSuggestion(id) {
  db.prepare("UPDATE staff_operator_suggestions SET status='dismissed', updated_at=unixepoch() WHERE id=?").run(id);
  return suggestionRowToJson(db.prepare('SELECT * FROM staff_operator_suggestions WHERE id=?').get(id));
}

function profileMetrics(profile) {
  const handoffs = db.prepare('SELECT * FROM colony_handoffs WHERE from_agent=? OR to_agent=?').all(profile.role_key, profile.role_key);
  // Dedupe identical handoffs: a looping worker once stacked 15 accepted
  // dev→QA handoffs with the same summary — counting those inflates the stat.
  const successKeys = new Set(
    handoffs
      .filter(h => ['pending', 'accepted', 'approved', 'awaiting_human'].includes(h.status))
      .map(h => `${h.colony_id}|${h.from_agent}|${h.to_agent}|${String(safeParse(h.payload, {})?.summary || '').trim()}`),
  );
  const successfulHandoffs = successKeys.size;
  const rejectedHandoffs = handoffs.filter(h => h.status === 'rejected' || h.protocol_status !== 'ok').length;
  const autoRecordedHandoffs = handoffs.filter(h => safeParse(h.payload, {})?.auto_recorded).length;
  const notes = db.prepare('SELECT * FROM colony_blackboard ORDER BY id DESC LIMIT 1000').all()
    .filter(e => roleMatchesProfile(profile, e.agent));
  const blockerCount = notes.filter(e => e.entry_type === 'blocker').length;
  const userComments = notes.filter(e => /^USER COMMENT/i.test(e.content || '')).length;
  const suggestions = db.prepare('SELECT status FROM staff_operator_suggestions WHERE profile_id=?').all(profile.id);
  const applied = suggestions.filter(s => s.status === 'applied').length;
  const logs = db.prepare('SELECT id, log FROM colonies ORDER BY created_at DESC LIMIT 100').all();
  let toolErrorCount = 0;
  let retryCount = 0; // loop-breaker trips (duplicate/identical-result/halt guards)
  for (const colony of logs) {
    for (const entry of safeParse(colony.log, [])) {
      if (!roleMatchesProfile(profile, entry.agent)) continue;
      if (entry.kind === 'tool_result' && entry.result?.error) {
        toolErrorCount++;
        // Count breaker trips specifically — the old /retry/i regex over the
        // whole entry JSON matched noise (any prompt or result mentioning it).
        if (/Duplicate call detected|HALTED|IDENTICAL result/i.test(String(entry.result.error))) retryCount++;
      }
    }
  }
  return {
    successful_handoffs: successfulHandoffs,
    rejected_handoffs: rejectedHandoffs,
    auto_recorded_handoffs: autoRecordedHandoffs,
    blocker_count: blockerCount,
    tool_error_count: toolErrorCount,
    retry_count: retryCount,
    user_comments_received: userComments,
    suggestion_acceptance_rate: suggestions.length ? applied / suggestions.length : 0,
    average_useful_output_latency_ms: null,
  };
}

// Evidence behind each performance metric, so the UI can drill down from a
// count to the underlying handoffs, blockers, tool errors, etc.
function profileMetricDetails(profile, limit = 50) {
  const teamByRun = new Map(db.prepare('SELECT id, team_id FROM colonies').all().map(r => [r.id, r.team_id || null]));
  const handoffs = db.prepare('SELECT * FROM colony_handoffs WHERE from_agent=? OR to_agent=? ORDER BY created_at DESC')
    .all(profile.role_key, profile.role_key);
  const handoffRow = h => ({
    id: h.id,
    colony_id: h.colony_id,
    team_id: teamByRun.get(h.colony_id) || null,
    from_agent: h.from_agent,
    to_agent: h.to_agent,
    status: h.status,
    protocol_status: h.protocol_status,
    created_at: h.created_at,
  });

  const notes = db.prepare('SELECT * FROM colony_blackboard ORDER BY id DESC LIMIT 1000').all()
    .filter(e => roleMatchesProfile(profile, e.agent));
  const noteRow = e => ({
    id: e.id,
    colony_id: e.colony_id,
    team_id: teamByRun.get(e.colony_id) || null,
    agent: e.agent,
    entry_type: e.entry_type,
    content: String(e.content || '').slice(0, 500),
    created_at: e.created_at,
  });

  const toolErrors = [];
  const retries = [];
  for (const colony of db.prepare('SELECT id, log FROM colonies ORDER BY created_at DESC LIMIT 100').all()) {
    for (const entry of safeParse(colony.log, [])) {
      if (!roleMatchesProfile(profile, entry.agent)) continue;
      if (entry.kind === 'tool_result' && entry.result?.error) {
        toolErrors.push({
          colony_id: colony.id,
          team_id: teamByRun.get(colony.id) || null,
          agent: entry.agent,
          tool: entry.tool || '',
          error: String(entry.result.error).slice(0, 300),
          ts: entry.ts || null,
        });
      }
      if (/retry/i.test(JSON.stringify(entry))) {
        retries.push({
          colony_id: colony.id,
          team_id: teamByRun.get(colony.id) || null,
          agent: entry.agent,
          kind: entry.kind || '',
          summary: String(entry.message || entry.tool || JSON.stringify(entry)).slice(0, 200),
          ts: entry.ts || null,
        });
      }
    }
  }

  return {
    successful_handoffs: handoffs.filter(h => ['pending', 'accepted', 'approved', 'awaiting_human'].includes(h.status)).slice(0, limit).map(handoffRow),
    rejected_handoffs: handoffs.filter(h => h.status === 'rejected' || h.protocol_status !== 'ok').slice(0, limit).map(handoffRow),
    auto_recorded_handoffs: handoffs.filter(h => safeParse(h.payload, {})?.auto_recorded).slice(0, limit).map(handoffRow),
    blocker_count: notes.filter(e => e.entry_type === 'blocker').slice(0, limit).map(noteRow),
    user_comments_received: notes.filter(e => /^USER COMMENT/i.test(e.content || '')).slice(0, limit).map(noteRow),
    tool_error_count: toolErrors.slice(0, limit),
    retry_count: retries.slice(0, limit),
  };
}

// Record which agent record was last seeded from a staff profile, so the
// profile can link back to its live worker agent.
function linkAssignedAgent(recipeId, roleKey, agentId, profileId = null) {
  if (!agentId) return;
  if (profileId) {
    db.prepare('UPDATE staff_profiles SET assigned_agent_id=?, updated_at=unixepoch() WHERE id=?')
      .run(agentId, profileId);
    return;
  }
  if (!recipeId || !roleKey) return;
  db.prepare('UPDATE staff_profiles SET assigned_agent_id=?, updated_at=unixepoch() WHERE recipe_id=? AND role_key=?')
    .run(agentId, recipeId, roleKey);
}

function backfillAssignedAgents() {
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='staff_assigned_agents_backfilled_v1'").get();
    if (done) return;
    const profiles = db.prepare("SELECT * FROM staff_profiles WHERE assigned_agent_id IS NULL OR assigned_agent_id=''").all().map(profileRowToJson);
    const runs = db.prepare(`
      SELECT id, recipe_id, agent_ids, created_at
      FROM colonies
      ORDER BY created_at DESC
      LIMIT 250
    `).all();
    if (profiles.length && runs.length) {
      const agentsById = new Map(db.prepare('SELECT id, name, persona_role FROM agents').all().map(a => [a.id, a]));
      const update = db.prepare('UPDATE staff_profiles SET assigned_agent_id=?, updated_at=unixepoch() WHERE id=?');
      for (const profile of profiles) {
        for (const run of runs) {
          if (run.recipe_id !== profile.recipe_id) continue;
          const ids = safeParse(run.agent_ids, []);
          const matchId = ids.find(id => {
            const agent = agentsById.get(id);
            return agent && (roleMatchesProfile(profile, agent.name) || roleMatchesProfile(profile, agent.persona_role));
          });
          if (matchId) {
            update.run(matchId, profile.id);
            break;
          }
        }
      }
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('staff_assigned_agents_backfilled_v1', '1')").run();
    }
  } catch (e) { logSwallowed('staffDirectory:backfillAssignedAgents', e); }
}

function profileInteractions(profile, limit = 80) {
  const teamByRun = new Map(db.prepare('SELECT id, team_id FROM colonies').all().map(r => [r.id, r.team_id || null]));
  const handoffs = db.prepare('SELECT * FROM colony_handoffs WHERE from_agent=? OR to_agent=? ORDER BY created_at DESC LIMIT ?')
    .all(profile.role_key, profile.role_key, limit)
    .map(r => ({ type: 'handoff', ...r, team_id: teamByRun.get(r.colony_id) || null, payload: safeParse(r.payload, {}) }));
  const blackboard = db.prepare('SELECT * FROM colony_blackboard ORDER BY id DESC LIMIT 500').all()
    .filter(e => roleMatchesProfile(profile, e.agent))
    .slice(0, limit)
    .map(r => ({ type: 'blackboard', ...r, team_id: teamByRun.get(r.colony_id) || null, meta: safeParse(r.meta, {}) }));
  const histories = db.prepare(`
    SELECT h.colony_id, h.agent_id, h.updated_at, h.history, a.name, a.persona_role
    FROM colony_agent_histories h JOIN agents a ON a.id=h.agent_id
    ORDER BY h.updated_at DESC LIMIT 300
  `).all()
    .filter(r => roleMatchesProfile(profile, r.name) || roleMatchesProfile(profile, r.persona_role))
    .slice(0, 20)
    // Full conversation per run (capped at 100 turns) — the UI scrolls; do
    // not truncate to the last few messages.
    .map(r => ({ type: 'history', colony_id: r.colony_id, team_id: teamByRun.get(r.colony_id) || null, agent_id: r.agent_id, updated_at: r.updated_at, history: safeParse(r.history, []).slice(-100) }));
  return { handoffs, blackboard, histories };
}

function profileRunContext(profile, limit = 8) {
  const rows = db.prepare(`
    SELECT c.id, c.team_id, c.goal, c.status, c.summary, c.created_at, c.agent_ids,
           t.name AS team_name
    FROM colonies c
    LEFT JOIN colony_teams t ON t.id=c.team_id
    WHERE c.recipe_id=?
    ORDER BY c.created_at DESC
    LIMIT 80
  `).all(profile.recipe_id);
  const agentsById = new Map(db.prepare('SELECT id, name, persona_role FROM agents').all().map(a => [a.id, a]));
  return rows
    .filter(row => safeParse(row.agent_ids, []).some(id => {
      const agent = agentsById.get(id);
      return agent && (roleMatchesProfile(profile, agent.name) || roleMatchesProfile(profile, agent.persona_role));
    }))
    .slice(0, limit)
    .map(row => ({
      id: row.id,
      team_id: row.team_id || null,
      team_name: row.team_name || '',
      goal: row.goal,
      status: row.status,
      summary: row.summary || '',
      created_at: row.created_at,
    }));
}

// Per-run scorecard: what this role actually did and how it ended, one row per
// recent run it crewed — answers "is this staff member improving across runs?"
// with step outcomes, handoffs, real-work counts, and failure signals.
function profileRunScorecard(profile, limit = 15) {
  const colonies = db.prepare('SELECT id, team_id, recipe_id, status, created_at, plan, log FROM colonies ORDER BY created_at DESC LIMIT 60').all();
  const rows = [];
  for (const colony of colonies) {
    if (rows.length >= limit) break;
    if (profile.recipe_id && colony.recipe_id && colony.recipe_id !== profile.recipe_id) continue;
    const log = safeParse(colony.log, []);
    const participated = log.some(e =>
      (e.kind === 'agent_ready' && (e.agent?.role_key === profile.role_key || e.agent?.name === profile.display_name))
      || roleMatchesProfile(profile, e.agent));
    if (!participated) continue;

    const stats = { tool_calls: 0, tool_errors: 0, breaker_trips: 0, files_written: 0, shell_commands: 0, silent_turns: 0 };
    for (const e of log) {
      if (roleMatchesProfile(profile, e.agent)) {
        if (e.kind === 'tool_call') {
          stats.tool_calls++;
          if (e.tool === 'write_file') stats.files_written++;
          if (e.tool === 'shell' || e.tool === 'run_python') stats.shell_commands++;
        }
        if (e.kind === 'tool_result' && e.result?.error) {
          stats.tool_errors++;
          if (/Duplicate call detected|HALTED|IDENTICAL result/i.test(String(e.result.error))) stats.breaker_trips++;
        }
      }
      // Silent turns surface on the operator side: ask_agent results naming
      // this worker with a no-output/halted marker as the response.
      if (e.kind === 'tool_result' && e.result?.agent_name && roleMatchesProfile(profile, e.result.agent_name)) {
        const resp = String(e.result.response || '');
        if (/^\((no response|agent reached max tool rounds|worker turn halted)/.test(resp)) stats.silent_turns++;
      }
    }

    const plan = safeParse(colony.plan, null);
    const own = (plan?.steps || []).filter(s => (s.assigned_to || null) === profile.role_key);
    const handoffs = db.prepare('SELECT * FROM colony_handoffs WHERE colony_id=? AND from_agent=?').all(colony.id, profile.role_key);
    const acceptedKeys = new Set(
      handoffs
        .filter(h => h.status !== 'rejected' && h.protocol_status === 'ok')
        .map(h => `${h.to_agent}|${String(safeParse(h.payload, {})?.summary || '').trim()}`),
    );

    rows.push({
      run_id: colony.id,
      team_id: colony.team_id || null,
      run_status: colony.status,
      created_at: colony.created_at,
      steps_assigned: own.length,
      steps_done: own.filter(s => s.status === 'done').length,
      steps_blocked: own.filter(s => s.status === 'blocked').length,
      handoffs_accepted: acceptedKeys.size,
      handoffs_rejected: handoffs.filter(h => h.status === 'rejected' || h.protocol_status !== 'ok').length,
      ...stats,
    });
  }
  return rows;
}

function profileBundle(id) {
  const profile = getProfile(id);
  if (!profile) return null;
  return {
    ...profile,
    metrics: profileMetrics(profile),
    metric_details: profileMetricDetails(profile),
    suggestions: listSuggestions(profile.id),
    interactions: profileInteractions(profile),
    runs: profileRunContext(profile),
    run_scorecard: profileRunScorecard(profile),
  };
}


module.exports = {
  seedStaffProfiles,
  listProfiles,
  getProfile,
  getProfileByRole,
  createProfile,
  deleteProfile,
  updateProfile,
  appendProfileMemory,
  selectProfileForRole,
  applyStaffProfilesToWorkerConfigs,
  agentConfigFromProfile,
  createAgentFromProfile,
  syncSuggestionsFromEvidence,
  listSuggestions,
  applySuggestion,
  dismissSuggestion,
  profileMetrics,
  profileMetricDetails,
  profileEffectiveConfig,
  resetProfileToRecipe,
  profileRunScorecard,
  linkAssignedAgent,
  profileInteractions,
  profileBundle,
};
