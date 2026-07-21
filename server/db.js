const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { logSwallowed } = require('./lib/logSwallowed');
const { runMigrations } = require('./lib/migrations');

// Tests set HIVE_DB_PATH to a throwaway file so they can never touch the user's
// real ~/.hive/hive.db. Without this, a crashed test run could strand state
// (e.g. a test ollama_url port) in the production DB.
const HIVE_DIR = process.env.HIVE_HOME || path.join(os.homedir(), '.hive');

const DB_PATH = process.env.HIVE_DB_PATH || path.join(HIVE_DIR, 'hive.db');

// Hard guard: a test process must NEVER open the real production DB. The
// canonical runner ("npm test") preloads server/tests/setup.js via --import,
// which repoints HIVE_DB_PATH at a temp file. But running a single file with a
// bare `node --test <file>` skips that preload and silently opens ~/.hive/hive.db
// — that is how a fake-Ollama test port once leaked into real settings and broke
// live runs. Detect the test context (Node's runner sets NODE_TEST_CONTEXT;
// Vitest sets VITEST) and fail loudly rather than corrupt user state.
const IS_TEST = !!process.env.NODE_TEST_CONTEXT || !!process.env.VITEST || process.env.NODE_ENV === 'test';
const PROD_DB_PATH = path.join(os.homedir(), '.hive', 'hive.db');
if (IS_TEST && path.resolve(DB_PATH) === path.resolve(PROD_DB_PATH)) {
  throw new Error(
    `Refusing to open the production Hive DB (${PROD_DB_PATH}) from a test process. ` +
    `Run the suite with "npm test", or add "--import ./server/tests/setup.js" to your ` +
    `node --test command so HIVE_DB_PATH points at a throwaway file.`,
  );
}

if (!fs.existsSync(HIVE_DIR)) fs.mkdirSync(HIVE_DIR, { recursive: true, mode: 0o700 });

const db = new Database(DB_PATH);

// Explicit SQLite operating policy: WAL permits readers during writes, NORMAL
// is the documented durability/performance balance for WAL, and busy_timeout
// avoids transient lock failures during background jobs/backups.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// Raw API keys may live in app_settings, so restrict the data dir and DB to
// the owning user (same convention as gh/aws CLI config). chmod also fixes
// perms on installs created before this guard; it is a no-op on Windows.
try {
  fs.chmodSync(HIVE_DIR, 0o700);
  fs.chmodSync(DB_PATH, 0o600);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(DB_PATH + suffix)) fs.chmodSync(DB_PATH + suffix, 0o600);
  }
} catch (e) {
  logSwallowed('db:permissions', e);
}

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
`);

// ── Schema migrations ─────────────────────────────────────────────────────────
// Additive schema changes are versioned + recorded in schema_migrations rather
// than run as bare `ALTER TABLE … catch {}`. See server/lib/migrations.js (#32).
runMigrations(db);

// One-time seeds of the skills catalog, in versioned batches. Each batch is
// guarded by its own flag so user deletions are not re-seeded on the next
// boot, while DBs that already ran an earlier batch still receive later ones
// (v2 carries the business/analysis skills for the expanded recipe catalog).
try {
  const { SKILL_SEEDS, SKILL_SEEDS_V2, SKILL_SEEDS_V3 } = require('./lib/skillSeeds');
  const { v4 } = require('./lib/uuid');
  const ins = db.prepare('INSERT OR IGNORE INTO skills (id, name, description, instructions, templates) VALUES (?, ?, ?, ?, ?)');
  for (const [flag, seeds] of [['skills_seeded_v1', SKILL_SEEDS], ['skills_seeded_v2', SKILL_SEEDS_V2], ['skills_seeded_v3', SKILL_SEEDS_V3]]) {
    const seeded = db.prepare('SELECT value FROM app_settings WHERE key=?').get(flag);
    if (seeded) continue;
    for (const s of seeds) {
      ins.run(v4(), s.name, s.description || '', s.instructions || '', JSON.stringify(s.templates || []));
    }
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, \'1\')').run(flag);
  }
} catch (e) { logSwallowed('db:skillsSeed', e); }

// ── Colony teams data migration ───────────────────────────────────────────────
// The colony_teams table + colonies.team_id are created by the versioned
// migrations above (see migrations.js). This one-time DATA migration folds all
// pre-existing runs (no team) into a default "Hive-TaskMaster" team so nothing
// is orphaned by the colony/run split.
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
} catch (e) { logSwallowed('db:colonyTeamsMigration', e); }

// One-time data migration: previously `personality` held the full system prompt
// override. Move it into the new `system_prompt` field so behavior is preserved,
// leaving `personality` free for actual personality/voice notes.
try {
  const done = db.prepare("SELECT value FROM app_settings WHERE key='staff_prompt_split_migrated'").get();
  if (!done) {
    db.exec("UPDATE staff_profiles SET system_prompt = personality, personality = '' WHERE system_prompt = '' AND personality != ''");
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('staff_prompt_split_migrated', '1')").run();
  }
} catch (e) { logSwallowed('db:staffPromptMigration', e); }

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
        } catch (e) { logSwallowed('db:legacySettingsMigration', e); }
        oldDb.close();
        console.log(`[hive] migrated ${rows.length} agent(s) from previous database`);
        return;
      }
      oldDb.close();
    } catch (e) { logSwallowed('db:legacyDbMigration', e); }
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
      try { dashMeta = JSON.parse(fs.readFileSync(dashPath, 'utf8')); } catch (e) { logSwallowed('db:legacyDashMeta', e, { path: dashPath }); }
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
