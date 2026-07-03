// Versioned, idempotent schema migrations (issue #32).
//
// Replaces the long list of bare `ALTER TABLE … catch {}` statements in db.js
// (which swallowed "duplicate column" errors) with an ordered, recorded set of
// migrations. A `schema_migrations` table tracks which versions have run, so the
// current schema version is detectable and half-applied states are visible.
//
// Every migration is idempotent: ADD COLUMN is guarded by PRAGMA table_info, and
// indexes/tables use `IF NOT EXISTS`. That matters because existing user DBs
// already have these columns (applied by the old bare ALTERs) but no
// schema_migrations rows — on the first versioned run each migration no-ops its
// DDL and simply records its version, reconciling the history without failing.
//
// db is passed in (never required here) to avoid a cycle with db.js.

const { logger } = require('./logger');

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// Idempotent ADD COLUMN — SQLite has no `ADD COLUMN IF NOT EXISTS`.
function addColumn(db, table, column, definition) {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Ordered migrations. Append new ones with the next version number — never
// renumber or edit an applied migration. Grouped to mirror the original
// db.js comment blocks.
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial additive columns + colony indexes',
    up(db) {
      addColumn(db, 'mcp_servers', 'env_secret_keys', "TEXT DEFAULT '[]'");
      addColumn(db, 'scheduled_runs', 'tools', "TEXT DEFAULT '[]'");
      addColumn(db, 'agents', 'persona_name', "TEXT DEFAULT ''");
      addColumn(db, 'agents', 'persona_role', "TEXT DEFAULT ''");
      addColumn(db, 'colonies', 'log', "TEXT DEFAULT '[]'");
      addColumn(db, 'colonies', 'summary', 'TEXT');
      addColumn(db, 'colonies', 'plan', 'TEXT');
      addColumn(db, 'colonies', 'recipe_id', "TEXT DEFAULT 'development_team'");
      addColumn(db, 'webhooks', 'context_spec', "TEXT DEFAULT '[]'");
      addColumn(db, 'webhooks', 'actions_config', "TEXT DEFAULT '[]'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_blackboard_colony ON colony_blackboard(colony_id, id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_handoffs_colony ON colony_handoffs(colony_id, created_at)');
    },
  },
  {
    version: 2,
    name: 'agents.ephemeral',
    up(db) { addColumn(db, 'agents', 'ephemeral', 'INTEGER DEFAULT 0'); },
  },
  {
    version: 3,
    name: 'agents gateway budget + key',
    up(db) {
      addColumn(db, 'agents', 'gateway_budget_usd', 'REAL');
      addColumn(db, 'agents', 'gateway_key', "TEXT DEFAULT ''");
    },
  },
  {
    version: 4,
    name: 'colonies deliverable/repo/board columns',
    up(db) {
      addColumn(db, 'colonies', 'deliverable', 'TEXT');
      addColumn(db, 'colonies', 'repo_path', 'TEXT');
      addColumn(db, 'colonies', 'board_card', 'TEXT');
    },
  },
  {
    version: 5,
    name: 'colonies cloud/model-plan/reasoning columns',
    up(db) {
      addColumn(db, 'colonies', 'cloud_enabled', 'INTEGER DEFAULT 0');
      addColumn(db, 'colonies', 'model_plan', 'TEXT');
      addColumn(db, 'colonies', 'reasoning_mode', "TEXT DEFAULT 'auto'");
    },
  },
  {
    version: 6,
    name: 'colonies trigger/bootstrap columns + handoff history_ref + indexes',
    up(db) {
      addColumn(db, 'colonies', 'trigger_config', 'TEXT');
      addColumn(db, 'colonies', 'trigger', 'TEXT');
      addColumn(db, 'colonies', 'bootstrap_tasks', 'TEXT');
      addColumn(db, 'colonies', 'bootstrap_accepted', 'INTEGER DEFAULT 0');
      addColumn(db, 'colony_handoffs', 'history_ref', 'TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_colony_trigger_events_unique ON colony_trigger_events(colony_id, event_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_colony_directions_pending ON colony_directions(colony_id, status, id)');
    },
  },
  {
    version: 7,
    name: 'colonies.github_writeback + staff indexes',
    up(db) {
      addColumn(db, 'colonies', 'github_writeback', 'INTEGER DEFAULT 0');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_profiles_recipe_role ON staff_profiles(recipe_id, role_key)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_staff_suggestions_profile_status ON staff_operator_suggestions(profile_id, status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_staff_chat_created ON staff_chat_messages(created_at)');
    },
  },
  {
    version: 8,
    name: 'staff_profiles.system_prompt',
    up(db) { addColumn(db, 'staff_profiles', 'system_prompt', "TEXT NOT NULL DEFAULT ''"); },
  },
  {
    version: 9,
    name: 'skills instructions + templates',
    up(db) {
      addColumn(db, 'skills', 'instructions', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'skills', 'templates', "TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 10,
    name: 'staff_profiles assigned_agent_id + chat_model',
    up(db) {
      addColumn(db, 'staff_profiles', 'assigned_agent_id', "TEXT DEFAULT ''");
      addColumn(db, 'staff_profiles', 'chat_model', "TEXT DEFAULT ''");
    },
  },
  {
    version: 11,
    name: 'colony_teams table + colonies.team_id + team memory + index',
    up(db) {
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
      addColumn(db, 'colonies', 'team_id', 'TEXT');
      addColumn(db, 'colony_teams', 'memory', "TEXT DEFAULT ''");
      db.exec('CREATE INDEX IF NOT EXISTS idx_colonies_team ON colonies(team_id, created_at)');
    },
  },
  {
    version: 12,
    name: 'staff_profiles seed-snapshot columns (prompt/tools drift detection)',
    up(db) {
      addColumn(db, 'staff_profiles', 'seeded_prompt', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'staff_profiles', 'seeded_tools', "TEXT NOT NULL DEFAULT '[]'");
      // Existing rows: assume pristine (never user-edited) so the next seed
      // pass refreshes them to the current recipe definitions. Stale seeded
      // profiles silently overrode every recipe prompt/tool improvement.
      db.exec("UPDATE staff_profiles SET seeded_prompt = system_prompt WHERE seeded_prompt = ''");
      db.exec("UPDATE staff_profiles SET seeded_tools = tools WHERE seeded_tools = '[]'");
    },
  },
  {
    version: 13,
    name: 'agents.reasoning (per-agent chat thinking toggle)',
    up(db) { addColumn(db, 'agents', 'reasoning', 'INTEGER DEFAULT 0'); },
  },
];

const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

// Apply all pending migrations in order. Each runs in its own transaction and
// is recorded only on success. A failing migration aborts startup — running
// against a half-migrated schema surfaces as confusing feature-level failures
// far from the actual cause.
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
  const record = db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)');
  let ran = 0;

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    try {
      db.transaction(() => { m.up(db); record.run(m.version, m.name); })();
      ran++;
    } catch (e) {
      logger.error('db', 'migration_failed', { version: m.version, name: m.name, error: e.message });
      throw new Error(`Database migration ${m.version} (${m.name}) failed: ${e.message}. Refusing to start on a half-migrated schema.`);
    }
  }

  const version = currentVersion(db);
  if (version < LATEST_VERSION) {
    throw new Error(`Database schema is at version ${version} but ${LATEST_VERSION} is required. Refusing to start on a half-migrated schema.`);
  }

  if (ran > 0) logger.info('db', 'migrations_applied', { count: ran, version });
  return { applied: ran, version };
}

function currentVersion(db) {
  try { return db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v || 0; }
  catch { return 0; }
}

module.exports = { runMigrations, currentVersion, MIGRATIONS, LATEST_VERSION, columnExists, addColumn };
