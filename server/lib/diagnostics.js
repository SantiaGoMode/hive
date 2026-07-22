const os = require('os');
const db = require('../db');
const config = require('./config');
const { getRecentLogs } = require('./logger');
const { currentVersion, LATEST_VERSION } = require('./migrations');
const databaseMaintenance = require('./databaseMaintenance');

const TABLES = [
  'agents', 'pipelines', 'pipeline_runs', 'scheduled_runs', 'colonies',
  'colony_teams', 'colony_run_jobs', 'colony_outbox', 'webhooks',
  'webhook_events', 'webhook_action_runs', 'mcp_servers', 'skills',
];

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

function tableCounts() {
  return Object.fromEntries(TABLES.map(table => [
    table,
    safe(() => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, null),
  ]));
}

function configured(name) {
  return Boolean(process.env[name]);
}

function colonyEventState() {
  return safe(() => db.prepare(`
    SELECT
      COUNT(*) AS total_runs,
      COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM colony_run_events e WHERE e.run_id=c.id) THEN 1 ELSE 0 END), 0) AS runs_with_events,
      COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM colony_run_events e WHERE e.run_id=c.id) THEN 1 ELSE 0 END), 0) AS runs_without_events
    FROM colonies c
  `).get(), null);
}

function buildDiagnostics() {
  const foreignKeyViolations = safe(() => db.pragma('foreign_key_check'), []);
  const discord = safe(() => require('./discord').status(), null);
  const gateway = safe(() => require('./gatewayHealth').getGatewayStatus(), null);
  return {
    format: 'hive-support-diagnostics',
    format_version: 1,
    generated_at: new Date().toISOString(),
    hive: {
      version: safe(() => require('../../package.json').version, null),
      schema_version: currentVersion(db),
      max_supported_schema_version: LATEST_VERSION,
      bind_scope: config.bindHost() === '127.0.0.1' || config.bindHost() === '::1' ? 'loopback' : 'non-loopback',
      uptime_seconds: Math.round(process.uptime()),
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu_count: os.cpus().length,
      memory_bytes: { total: os.totalmem(), free: os.freemem() },
    },
    database: {
      integrity: databaseMaintenance.integrityCheck(),
      foreign_key_violations: foreignKeyViolations,
      pragmas: {
        journal_mode: safe(() => db.pragma('journal_mode', { simple: true }), null),
        synchronous: safe(() => db.pragma('synchronous', { simple: true }), null),
        foreign_keys: safe(() => Boolean(db.pragma('foreign_keys', { simple: true })), null),
        busy_timeout_ms: safe(() => db.pragma('busy_timeout', { simple: true }), null),
      },
      table_counts: tableCounts(),
      backup_count: safe(() => databaseMaintenance.listBackups().length, null),
      colony_event_state: colonyEventState(),
    },
    queues: {
      automation: safe(() => ({
        durable: require('./automationJobs').status(),
        dispatcher: require('./automationQueue').status(),
      }), null),
      active_colony_runs: safe(() => require('./colonyRunner').activeRunCount(), null),
      active_pipeline_runs: safe(() => require('./pipelineRunner').activeRunCount(), null),
    },
    integrations: {
      gateway: gateway ? { enabled: Boolean(gateway.enabled), reachable: Boolean(gateway.reachable) } : null,
      discord: discord ? { state: discord.state, setup_required: Boolean(discord.setup_required) } : null,
      ngrok_active: safe(() => Boolean(require('./ngrokService').getTunnelUrl()), false),
      credentials_present: {
        anthropic: configured('ANTHROPIC_API_KEY'),
        openai: configured('OPENAI_API_KEY'),
        gemini: configured('GEMINI_API_KEY'),
        github: configured('GITHUB_TOKEN') || configured('GITHUB_PERSONAL_ACCESS_TOKEN') || configured('GH_TOKEN'),
        discord: configured('DISCORD_BOT_TOKEN'),
      },
    },
    recent_warnings_and_errors: getRecentLogs(100),
    redaction: {
      policy: 'No database rows, prompts, paths, URLs, headers, or credential values are included.',
    },
  };
}

module.exports = { buildDiagnostics, colonyEventState, tableCounts };
