// Hive admin tools (`hive_admin` group). The Steward (#general chief of staff)
// runs the operator's whole install, so it needs to inspect and modify the
// things the Staff, Skills & Tools, and Settings pages expose — not just the
// live agent roster. These tools wrap staffDirectory (staff profiles), the
// skills catalog, the built-in/MCP tool registry, and non-secret app settings.
//
// Kept read-broad, write-narrow: reads are unrestricted; writes touch staff
// profiles, skills, and an allowlist of safe settings only. Secrets are never
// returned or writable here (that stays on the Settings page / secrets.js).
const db = require('../../db');
const staffDirectory = require('../staffDirectory');
const { v4 } = require('../uuid');

// Lazy requires: these pull the registry/mcp graph which requires this module.
const builtInToolCatalog = () => require('./registry').builtInToolCatalog();
const mcpStatus = () => { try { return require('../mcpClient').getStatus(); } catch { return []; } };

// Settings the Steward may read (secrets excluded entirely).
const READABLE_SETTINGS = [
  'ollama_url', 'theme', 'accent_color', 'font_size', 'ngrok_domain', 'ngrok_enabled',
  'webhook_public_url', 'llm_gateway_url', 'hive_allowed_origins', 'discord_health_repo',
  'colony_timeout_minutes',
];
// Settings the Steward may write — a safe, non-secret subset of the above.
const WRITABLE_SETTINGS = [
  'ollama_url', 'theme', 'accent_color', 'font_size', 'ngrok_domain', 'ngrok_enabled',
  'webhook_public_url', 'llm_gateway_url', 'discord_health_repo',
  'colony_timeout_minutes',
];

function profileSummary(p) {
  return {
    id: p.id, display_name: p.display_name, role: p.role, recipe_id: p.recipe_id, role_key: p.role_key,
    model_preference: p.model_preference || '(default)', skills: p.skills, tools: p.tools,
    assigned_agent_id: p.assigned_agent_id || null,
  };
}

module.exports = {
  // ── Staff profiles ──────────────────────────────────────────────────────────
  list_staff: {
    group: 'hive_admin',
    definition: {
      type: 'function',
      function: {
        name: 'list_staff',
        description: 'List every staff profile (the editable personas on the Staff page): id, display name, role, recipe, preferred model, assigned skills and tool groups. These back the colony crews and bridge personas — distinct from live agents (use list_agents for those).',
        parameters: { type: 'object', properties: {} },
      },
    },
    async handler() {
      return { staff: staffDirectory.listProfiles().map(profileSummary) };
    },
  },

  // ── Colony runs ───────────────────────────────────────────────────────────
  start_colony_mission: {
    group: 'hive_admin',
    definition: {
      type: 'function',
      function: {
        name: 'start_colony_mission',
        description: 'Start a Colony Run (a real team mission) for a colony team, given the team name (or id) and the work item / mission direction. This launches the actual seeded crew and its recipe handoff flow. Use this whenever the operator asks to "start a colony run", "run the colony", or "kick off a mission" for a named team. If the team is already running, the work is queued instead. Do NOT fulfill a colony-run request by creating agents or pipelines — always use this tool.',
        parameters: {
          type: 'object',
          properties: {
            team: { type: 'string', description: 'Colony team name (or id), e.g. "Quantum Insights".' },
            direction: { type: 'string', description: 'The work item / mission direction to run, restated clearly from the operator\'s request.' },
          },
          required: ['team', 'direction'],
        },
      },
    },
    async handler({ team: teamQuery, direction }) {
      const colonyTeams = require('../colonyTeams');
      const q = String(teamQuery || '').trim().toLowerCase();
      if (!q) return { error: 'A team name or id is required.' };
      const teams = colonyTeams.listTeams();
      const team = teams.find(t => t.id === q || t.name.toLowerCase() === q)
        || teams.find(t => t.name.toLowerCase().includes(q));
      if (!team) return { error: `No colony team matches "${teamQuery}". Known teams: ${teams.map(t => t.name).join(', ') || '(none)'}.` };
      const dir = String(direction || '').trim();
      if (!dir) return { error: 'A mission direction (the work item) is required.' };
      // Resolve the model the way the Discord Operator does — the seeded Colony
      // Operator agent's configured model.
      let model = null;
      try { model = require('../discord/operator').ensureOperatorAgent()?.model || null; } catch { /* handled below */ }
      if (!model) return { error: 'No Operator model is available. Set a model for the Colony Operator on the Staff page, then retry.' };
      const missions = require('../discord/missions');
      try {
        if (missions.activeRunForTeam(team.id)) {
          const { item } = missions.queueTeamWork(team.id, dir, dir.slice(0, 80));
          return { success: true, queued: true, team: team.name, item_id: item.id, message: `${team.name} is already running a mission — queued this work (item ${item.id}); it starts when the current run finishes.` };
        }
        const { runId } = missions.launchTeamMission(team.id, dir, { model, source: 'manual', matchReason: 'Steward: start colony run' });
        return { success: true, run_id: runId, team: team.name, message: `Started a colony run for ${team.name} (run ${runId}). Progress posts to the team's colony thread.` };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

  get_staff: {
    group: 'hive_admin',
    definition: {
      type: 'function',
      function: {
        name: 'get_staff',
        description: 'Full detail for one staff profile by id: system prompt, personality, model, skills, tools, memory, and whether each field was customized away from its recipe default.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Staff profile id (from list_staff).' } },
          required: ['id'],
        },
      },
    },
    async handler({ id }) {
      const profile = staffDirectory.getProfile(String(id || ''));
      if (!profile) return { error: `No staff profile with id "${id}". Call list_staff for valid ids.` };
      return { staff: profile };
    },
  },

  update_staff: {
    group: 'hive_admin',
    definition: {
      type: 'function',
      function: {
        name: 'update_staff',
        description: 'Update a staff profile. Only the fields you pass change. Use to retune a persona\'s prompt/personality, change its preferred model, or adjust its skills and tool groups. Get valid tool-group values from list_tool_groups and skill names from list_skills.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Staff profile id (from list_staff).' },
            display_name: { type: 'string' },
            role: { type: 'string' },
            system_prompt: { type: 'string' },
            personality: { type: 'string' },
            model_preference: { type: 'string', description: 'Model id, or empty string to fall back to the recipe/system default.' },
            skills: { type: 'array', items: { type: 'string' }, description: 'Full replacement list of skill names.' },
            tools: { type: 'array', items: { type: 'string' }, description: 'Full replacement list of tool-group values (e.g. "web_search", "mcp:xyz").' },
          },
          required: ['id'],
        },
      },
    },
    async handler({ id, ...patch }) {
      const profile = staffDirectory.getProfile(String(id || ''));
      if (!profile) return { error: `No staff profile with id "${id}". Call list_staff for valid ids.` };
      const updated = staffDirectory.updateProfile(profile.id, patch);
      // Re-materialize the linked agent so the change takes effect immediately.
      try { staffDirectory.createAgentFromProfile(profile.id); } catch { /* agent relink is best-effort */ }
      return { success: true, staff: profileSummary(updated) };
    },
  },

  // ── Tool catalog ────────────────────────────────────────────────────────────
  list_tool_groups: {
    group: 'hive_admin',
    definition: {
      type: 'function',
      function: {
        name: 'list_tool_groups',
        description: 'List the tool groups an agent or staff profile can be granted: built-in groups (with the functions each exposes) and connected MCP servers. Use the returned "value" strings when setting tools on a staff profile.',
        parameters: { type: 'object', properties: {} },
      },
    },
    async handler() {
      const internal = new Set(['delegation', 'protocol_worker', 'sandbox_files', 'colony_operator']);
      const catalog = builtInToolCatalog();
      const builtin = Object.keys(catalog).filter(g => !internal.has(g)).map(group => ({
        value: group, kind: 'builtin', functions: catalog[group].map(f => f.name),
      }));
      const mcp = mcpStatus().map(s => ({
        value: `mcp:${s.id}`, kind: 'mcp', label: s.name, connected: s.connected,
        functions: s.tool_names || [],
      }));
      return { tool_groups: [...builtin, ...mcp] };
    },
  },

  // ── Skills catalog ──────────────────────────────────────────────────────────
  create_skill: {
    group: 'hive_admin',
    definition: {
      type: 'function',
      function: {
        name: 'create_skill',
        description: 'Add a new skill to the Hive catalog so agents can load it. A skill is reusable instructions (and optional templates) an agent pulls in on demand.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique skill name.' },
            description: { type: 'string', description: 'One-line summary shown in the catalog.' },
            instructions: { type: 'string', description: 'The skill body — the guidance an agent applies when it loads this skill.' },
          },
          required: ['name', 'instructions'],
        },
      },
    },
    async handler({ name, description, instructions }) {
      const trimmed = String(name || '').trim();
      if (!trimmed) return { error: 'name is required' };
      const id = v4();
      try {
        db.prepare('INSERT INTO skills (id, name, description, instructions, templates) VALUES (?, ?, ?, ?, ?)')
          .run(id, trimmed, String(description || '').trim(), String(instructions || ''), '[]');
      } catch {
        return { error: `A skill named "${trimmed}" already exists — use update_skill instead.` };
      }
      return { success: true, skill: { id, name: trimmed } };
    },
  },

  update_skill: {
    group: 'hive_admin',
    definition: {
      type: 'function',
      function: {
        name: 'update_skill',
        description: 'Edit an existing skill in the catalog by name. Only the fields you pass change.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Current skill name (from list_skills).' },
            new_name: { type: 'string', description: 'Rename the skill (optional).' },
            description: { type: 'string' },
            instructions: { type: 'string' },
          },
          required: ['name'],
        },
      },
    },
    async handler({ name, new_name, description, instructions }) {
      const row = db.prepare('SELECT * FROM skills WHERE name = ? COLLATE NOCASE').get(String(name || '').trim());
      if (!row) return { error: `No skill named "${name}". Call list_skills for valid names.` };
      const nextName = new_name != null ? String(new_name).trim() : row.name;
      if (!nextName) return { error: 'name cannot be empty' };
      try {
        db.prepare('UPDATE skills SET name=?, description=?, instructions=?, updated_at=unixepoch() WHERE id=?')
          .run(nextName,
            description != null ? String(description).trim() : row.description,
            instructions != null ? String(instructions) : row.instructions,
            row.id);
      } catch {
        return { error: `A skill named "${nextName}" already exists.` };
      }
      // Propagate a rename into staff profiles that reference the old name.
      if (nextName !== row.name) {
        for (const p of db.prepare('SELECT id, skills FROM staff_profiles').all()) {
          let skills; try { skills = JSON.parse(p.skills || '[]'); } catch { continue; }
          if (!Array.isArray(skills) || !skills.includes(row.name)) continue;
          db.prepare('UPDATE staff_profiles SET skills=?, updated_at=unixepoch() WHERE id=?')
            .run(JSON.stringify(skills.map(s => (s === row.name ? nextName : s))), p.id);
        }
      }
      return { success: true, skill: { id: row.id, name: nextName } };
    },
  },

  delete_skill: {
    group: 'hive_admin',
    definition: {
      type: 'function',
      function: {
        name: 'delete_skill',
        description: 'Remove a skill from the catalog by name. This is destructive — confirm with the operator before calling.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Skill name (from list_skills).' } },
          required: ['name'],
        },
      },
    },
    async handler({ name }) {
      const row = db.prepare('SELECT id, name FROM skills WHERE name = ? COLLATE NOCASE').get(String(name || '').trim());
      if (!row) return { error: `No skill named "${name}". Call list_skills for valid names.` };
      db.prepare('DELETE FROM skills WHERE id=?').run(row.id);
      return { success: true, deleted: row.name };
    },
  },

  // ── Settings ────────────────────────────────────────────────────────────────
  get_settings: {
    group: 'hive_admin',
    definition: {
      type: 'function',
      function: {
        name: 'get_settings',
        description: 'Read Hive\'s non-secret settings (models endpoint, gateway URL, theme, ngrok/webhook config, Discord health repo). API keys and tokens are never returned here.',
        parameters: { type: 'object', properties: {} },
      },
    },
    async handler() {
      const settings = {};
      for (const key of READABLE_SETTINGS) {
        settings[key] = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value ?? '';
      }
      return { settings, writable: WRITABLE_SETTINGS };
    },
  },

  update_setting: {
    group: 'hive_admin',
    definition: {
      type: 'function',
      function: {
        name: 'update_setting',
        description: 'Change one non-secret Hive setting. Allowed keys: ' + WRITABLE_SETTINGS.join(', ') + '. Secrets/API keys must be set on the Settings page, not here.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Setting key (must be one of the allowed writable keys).' },
            value: { type: 'string', description: 'New value.' },
          },
          required: ['key', 'value'],
        },
      },
    },
    async handler({ key, value }) {
      const k = String(key || '').trim();
      if (!WRITABLE_SETTINGS.includes(k)) {
        return { error: `"${k}" is not a writable setting here. Allowed: ${WRITABLE_SETTINGS.join(', ')}. Secrets must be set on the Settings page.` };
      }
      db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(k, String(value ?? ''));
      try { require('../config').invalidateSettingsCache(k); } catch { /* cache invalidation is best-effort */ }
      return { success: true, key: k, value: String(value ?? '') };
    },
  },
};
