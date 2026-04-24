const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Tests set HIVE_DB_PATH to a throwaway file so they can never touch the user's
// real ~/.hive/hive.db. Without this, a crashed test run could strand state
// (e.g. a test ollama_url port) in the production DB.
const HIVE_DIR = path.join(os.homedir(), '.hive');
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
`);

// ── Schema migrations (additive only) ─────────────────────────────────────────
try { db.exec("ALTER TABLE mcp_servers ADD COLUMN env_secret_keys TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE scheduled_runs ADD COLUMN tools TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN persona_name TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN persona_role TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN log TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN summary TEXT"); } catch {}
try { db.exec("ALTER TABLE colonies ADD COLUMN plan TEXT"); } catch {}

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
