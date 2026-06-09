const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Tests set HIVE_DB_PATH to a throwaway file so they can never touch the user's
// real ~/.hive/hive.db. Without this, a crashed test run could strand state
// (e.g. a test ollama_url port) in the production DB.
const HIVE_DIR = process.env.HIVE_HOME || path.join(os.homedir(), '.hive');
if (!fs.existsSync(HIVE_DIR)) fs.mkdirSync(HIVE_DIR, { recursive: true });

const DB_PATH = process.env.HIVE_DB_PATH || path.join(HIVE_DIR, 'hive.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT DEFAULT '',
    description TEXT DEFAULT '',
    avatar_color TEXT DEFAULT '#3b82f6',
    temperature REAL DEFAULT 0.7,
    max_tokens INTEGER DEFAULT 4096,
    context_length INTEGER DEFAULT 8192,
    tools TEXT DEFAULT '[]',
    system_prompt TEXT DEFAULT '',
    workspace TEXT,
    last_active INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS pipelines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    pipeline_name TEXT NOT NULL,
    input TEXT NOT NULL,
    trace TEXT NOT NULL DEFAULT '[]',
    final_output TEXT,
    total_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    ran_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS scheduled_runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    label TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run INTEGER,
    last_output TEXT,
    last_error TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sessions_meta (
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    PRIMARY KEY (agent_id, session_id)
  );
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport TEXT NOT NULL DEFAULT 'stdio',
    command TEXT,
    args TEXT DEFAULT '[]',
    env TEXT DEFAULT '{}',
    url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS colonies (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    orchestrator_id TEXT,
    agent_ids TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    secret TEXT DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    event_type TEXT DEFAULT 'webhook',
    payload TEXT NOT NULL DEFAULT '{}',
    headers TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS webhook_action_runs (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    action_id TEXT,
    action_label TEXT DEFAULT '',
    action_type TEXT NOT NULL,
    target_id TEXT,
    input TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    output TEXT,
    error TEXT,
    pipeline_run_id TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    completed_at INTEGER
  );
  -- ── Colony Communication Protocol ──────────────────────────────────────────
  -- Shared Context Layer ("Blackboard"): an append-only log all agents in a
  -- colony read from and write to. Each row is one state/blocker/checkpoint/
  -- progress entry. Unlike the global SHARED.md notepad, this is colony-scoped
  -- and never overwritten — agents accumulate context instead of clobbering it.
  CREATE TABLE IF NOT EXISTS colony_blackboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    entry_type TEXT NOT NULL DEFAULT 'state',
    content TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch())
  );
  -- Handoff ledger: every command object passed between agents. Records the
  -- A2A/ACP envelope, precondition result, and human-in-the-loop approval state.
  CREATE TABLE IF NOT EXISTS colony_handoffs (
    id TEXT PRIMARY KEY,
    colony_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    protocol_status TEXT NOT NULL DEFAULT 'ok',
    requires_human BOOLEAN NOT NULL DEFAULT 0,
    human_decision TEXT,
    human_note TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS colony_trigger_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    webhook_id TEXT NOT NULL,
    triggered_colony_id TEXT,
    event_type TEXT NOT NULL DEFAULT 'webhook',
    source_url TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(colony_id, event_id)
  );
  CREATE TABLE IF NOT EXISTS colony_directions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    colony_id TEXT NOT NULL,
    content TEXT NOT NULL,
    target_role TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at INTEGER DEFAULT (unixepoch()),
    delivered_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS colony_agent_histories (
    colony_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    history TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (colony_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS staff_profiles (
    id TEXT PRIMARY KEY,
    recipe_id TEXT NOT NULL,
    role_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '[]',
    tools TEXT NOT NULL DEFAULT '[]',
    model_preference TEXT DEFAULT '',
    memory TEXT NOT NULL DEFAULT '',
    avatar_color TEXT DEFAULT '#3b82f6',
    chat_enabled INTEGER NOT NULL DEFAULT 0,
    chat_interval_minutes INTEGER NOT NULL DEFAULT 10,
    last_chat_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(recipe_id, role_key)
  );
  CREATE TABLE IF NOT EXISTS staff_operator_suggestions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    colony_id TEXT,
    evidence_type TEXT NOT NULL,
    evidence_ref TEXT NOT NULL,
    target_field TEXT NOT NULL,
    proposed_value TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'operator',
    status TEXT NOT NULL DEFAULT 'pending',
    applied_value TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(profile_id, evidence_type, evidence_ref, target_field)
  );
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    templates TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS staff_chat_messages (
    id TEXT PRIMARY KEY,
    author_type TEXT NOT NULL DEFAULT 'profile',
    author_profile_id TEXT,
    content TEXT NOT NULL,
    mentions TEXT NOT NULL DEFAULT '[]',
    trigger_type TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER DEFAULT (unixepoch())
  );
`);

// ── Schema migrations (additive only) ─────────────────────────────────────────
try { db.exec("ALTER TABLE mcp_servers ADD COLUMN env_secret_keys TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE scheduled_runs ADD COLUMN tools TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN persona_name TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN persona_role TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN log TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN summary TEXT"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN plan TEXT"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN recipe_id TEXT DEFAULT 'development_team'"); } catch {}
try { db.exec("ALTER TABLE webhooks ADD COLUMN context_spec TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE webhooks ADD COLUMN actions_config TEXT DEFAULT '[]'"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_blackboard_colony ON colony_blackboard(colony_id, id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_handoffs_colony ON colony_handoffs(colony_id, created_at)"); } catch {}
// Colony-owned worker/operator agents are ephemeral — they back a colony run and
// should not surface in the main Agents list. Additive, defaults to 0 (visible).
try { db.exec("ALTER TABLE agents ADD COLUMN ephemeral INTEGER DEFAULT 0"); } catch {}
// Per-agent LLM-gateway budget (USD) + the virtual key minted for it. When a
// budget is set, Hive mints a LiteLLM key with that max_budget and uses it as
// the agent's gateway auth key, so the gateway enforces the cap + attributes spend.
try { db.exec("ALTER TABLE agents ADD COLUMN gateway_budget_usd REAL"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN gateway_key TEXT DEFAULT ''"); } catch {}
// Structured deliverable assembled from a colony's handoff ledger (JSON).
try { db.exec("ALTER TABLE colonies ADD COLUMN deliverable TEXT"); } catch {}
// Per-colony repo + linked board work-item (replaces relying on one global repo
// path for every colony). repo_path is a local git path; board_card is the
// JSON of the source issue/card this colony was launched against.
try { db.exec("ALTER TABLE colonies ADD COLUMN repo_path TEXT"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN board_card TEXT"); } catch {}
// Cloud models opt-in (0 = local Ollama only) + the operator's per-role model
// plan (JSON role_key → model id). When the operator/user assigns models, each
// worker is seeded with its own model instead of one model for the whole colony.
try { db.exec("ALTER TABLE colonies ADD COLUMN cloud_enabled INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN model_plan TEXT"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN reasoning_mode TEXT DEFAULT 'auto'"); } catch {}
// Per-colony webhook trigger routing. trigger_config is user-editable routing
// state; trigger is immutable provenance for an automatically-started run.
try { db.exec("ALTER TABLE colonies ADD COLUMN trigger_config TEXT"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN trigger TEXT"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN bootstrap_tasks TEXT"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN bootstrap_accepted INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE colony_handoffs ADD COLUMN history_ref TEXT"); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_colony_trigger_events_unique ON colony_trigger_events(colony_id, event_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_colony_directions_pending ON colony_directions(colony_id, status, id)"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN github_writeback INTEGER DEFAULT 0"); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_profiles_recipe_role ON staff_profiles(recipe_id, role_key)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_staff_suggestions_profile_status ON staff_operator_suggestions(profile_id, status)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_staff_chat_created ON staff_chat_messages(created_at)"); } catch {}
// Personality split out of the core system prompt for staff profiles. The
// system_prompt (when set) overrides the recipe role's base prompt; the
// personality is appended as its own section.
try { db.exec("ALTER TABLE staff_profiles ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''"); } catch {}
// Skills are richer than a name + description: they carry working instructions
// and reusable templates (code, tables, text) injected into assigned staff prompts.
try { db.exec("ALTER TABLE skills ADD COLUMN instructions TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE skills ADD COLUMN templates TEXT NOT NULL DEFAULT '[]'"); } catch {}
// Link a staff profile to the most recent colony worker agent seeded from it,
// and let autonomous staff chat use a (typically smaller) dedicated model.
try { db.exec("ALTER TABLE staff_profiles ADD COLUMN assigned_agent_id TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE staff_profiles ADD COLUMN chat_model TEXT DEFAULT ''"); } catch {}
// One-time seed of a starter skills catalog (demo/testing). Guarded by a flag
// so user deletions are not re-seeded on the next boot.
try {
  const seeded = db.prepare("SELECT value FROM app_settings WHERE key='skills_seeded_v1'").get();
  if (!seeded) {
    const { SKILL_SEEDS } = require('./lib/skillSeeds');
    const { v4 } = require('./lib/uuid');
    const ins = db.prepare('INSERT OR IGNORE INTO skills (id, name, description, instructions, templates) VALUES (?, ?, ?, ?, ?)');
    for (const s of SKILL_SEEDS) {
      ins.run(v4(), s.name, s.description || '', s.instructions || '', JSON.stringify(s.templates || []));
    }
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('skills_seeded_v1', '1')").run();
  }
} catch {}
// ── Colony teams ──────────────────────────────────────────────────────────────
// A "Colony" is now a named, persistent team (e.g. "Hive-TaskMaster") that owns
// many runs. The legacy `colonies` table rows become *runs* under a team via
// the new team_id column. Repo/project + base config live on the team; the
// per-run row keeps execution state (goal, log, plan, deliverable, …).
db.exec(`
  CREATE TABLE IF NOT EXISTS colony_teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    recipe_id TEXT DEFAULT 'development_team',
    repo_path TEXT,
    cloud_enabled INTEGER DEFAULT 0,
    github_writeback INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );
`);
try { db.exec('ALTER TABLE colonies ADD COLUMN team_id TEXT'); } catch {}
// Shared colony memory — durable knowledge the operator distills after each
// run, editable from the colony page, injected into every agent's prompt.
try { db.exec("ALTER TABLE colony_teams ADD COLUMN memory TEXT DEFAULT ''"); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_colonies_team ON colonies(team_id, created_at)'); } catch {}
// One-time migration: fold all pre-existing runs (no team) into a default
// "Hive-TaskMaster" team so nothing is orphaned by the colony/run split.
try {
  const done = db.prepare("SELECT value FROM app_settings WHERE key='colony_teams_migrated_v1'").get();
  if (!done) {
    const orphans = db.prepare('SELECT COUNT(*) AS n FROM colonies WHERE team_id IS NULL').get();
    if (orphans.n > 0) {
      let team = db.prepare("SELECT id FROM colony_teams WHERE name='Hive-TaskMaster'").get();
      if (!team) {
        const repoPath = db.prepare("SELECT value FROM app_settings WHERE key='colony_repo_path'").get()?.value || null;
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        db.prepare('INSERT INTO colony_teams (id, name, description, recipe_id, repo_path) VALUES (?, ?, ?, ?, ?)')
          .run(id, 'Hive-TaskMaster', 'Default colony — migrated from pre-team runs.', 'development_team', repoPath);
        team = { id };
      }
      db.prepare('UPDATE colonies SET team_id=? WHERE team_id IS NULL').run(team.id);
    }
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('colony_teams_migrated_v1', '1')").run();
  }
} catch {}

// One-time data migration: previously `personality` held the full system prompt
// override. Move it into the new `system_prompt` field so behavior is preserved,
// leaving `personality` free for actual personality/voice notes.
try {
  const done = db.prepare("SELECT value FROM app_settings WHERE key='staff_prompt_split_migrated'").get();
  if (!done) {
    db.exec("UPDATE staff_profiles SET system_prompt = personality, personality = '' WHERE system_prompt = '' AND personality != ''");
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('staff_prompt_split_migrated', '1')").run();
  }
} catch {}

// Default settings
const settingsDefaults = { ollama_url: 'http://localhost:11434' };
const insertSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(settingsDefaults)) insertSetting.run(k, v);

// ── One-time migration from legacy installations ──────────────────────────────
// Migrated agents keep their existing workspace paths so memory/sessions survive.

function migrate() {
  const count = db.prepare('SELECT COUNT(*) as n FROM agents').get().n;
  if (count > 0) return;

  // Try migrating from legacy DB first
  const oldDbPath = path.join(os.homedir(), '.openclaw-dash', 'ui-metadata.db');
  if (fs.existsSync(oldDbPath)) {
    try {
      const oldDb = new Database(oldDbPath);
      const rows = oldDb.prepare('SELECT * FROM agents').all();
      if (rows.length > 0) {
        const ins = db.prepare(`
          INSERT OR IGNORE INTO agents (id, name, model, description, avatar_color, temperature, max_tokens, context_length, tools, system_prompt, workspace, last_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of rows) {
          ins.run(r.id, r.name, r.model, r.description, r.avatar_color, r.temperature, r.max_tokens, r.context_length, r.tools, r.system_prompt, r.workspace, r.last_active, r.created_at, r.updated_at);
        }
        // Migrate settings
        try {
          const settings = oldDb.prepare('SELECT * FROM app_settings').all();
          for (const s of settings) {
            if (s.key === 'ollama_url') insertSetting.run(s.key, s.value);
          }
        } catch {}
        oldDb.close();
        console.log(`[hive] migrated ${rows.length} agent(s) from previous database`);
        return;
      }
      oldDb.close();
    } catch {}
  }

  // Fall back: try importing from legacy config
  const legacyPath = path.join(os.homedir(), '.openclaw');
  const configPath = path.join(legacyPath, 'openclaw.json');
  if (!fs.existsSync(configPath)) return;

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return; }

  const list = cfg.agents?.list || [];
  const cfgDefaults = cfg.agents?.defaults || {};
  const SOUL_MARKER = '<!-- legacy-system-prompt -->';

  const ins = db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, model, description, avatar_color, temperature, max_tokens, context_length, tools, system_prompt, workspace)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const entry of list) {
    const id = entry.id;
    if (!id) continue;

    const workspace = (entry.workspace || path.join(legacyPath, `workspace-${id}`)).replace(/^~/, os.homedir());

    let system_prompt = '';
    const soulPath = path.join(workspace, 'SOUL.md');
    if (fs.existsSync(soulPath)) {
      const content = fs.readFileSync(soulPath, 'utf8');
      const idx = content.indexOf(SOUL_MARKER);
      system_prompt = idx >= 0 ? content.slice(idx + SOUL_MARKER.length).trim() : content.trim();
    }

    let dashMeta = {};
    const dashPath = path.join(legacyPath, 'agents', id, 'dash.json');
    if (fs.existsSync(dashPath)) {
      try { dashMeta = JSON.parse(fs.readFileSync(dashPath, 'utf8')); } catch {}
    }

    const model = (entry.model || cfgDefaults?.model?.primary || '').replace(/^ollama\//, '');

    ins.run(
      id,
      entry.name || entry.identity?.name || id,
      model,
      dashMeta.description || '',
      dashMeta.avatar_color || '#3b82f6',
      dashMeta.temperature ?? 0.7,
      dashMeta.max_tokens ?? 4096,
      dashMeta.context_length ?? 8192,
      JSON.stringify(dashMeta.tools || []),
      system_prompt,
      workspace,
    );
  }

  const migrated = db.prepare('SELECT COUNT(*) as n FROM agents').get().n;
  if (migrated > 0) console.log(`[hive] migrated ${migrated} agent(s) from legacy config`);
}

migrate();

module.exports = db;
