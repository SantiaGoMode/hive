const { logger } = require('./lib/logger');

process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection', { reason: reason?.message || String(reason) });
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.error('process', 'uncaughtException', { error: err?.message || String(err) });
  shutdown('uncaughtException', 1);
});

const http = require('http');
const { createApp } = require('./app');
const { createWebSocketServer } = require('./lib/websocket');
require('./lib/scheduler');
const schedulerLifecycle = require('./lib/schedulerLifecycle');
const mcpManager = require('./lib/mcpClient');
const ngrokService = require('./lib/ngrokService');
const db = require('./db');
const config = require('./lib/config');
const gatewayHealth = require('./lib/gatewayHealth');
const { settingSecret } = require('./lib/secrets');
const {
  assertCanExposePublicly,
  ensureAuthTokenConfigured,
} = require('./lib/auth');

// Auth is token-based even on loopback: any local process can reach the API,
// so an unauthenticated local mode is not a real boundary. Generate + persist
// a token on first boot; the UI prompts for it once (copy from Settings env,
// server log, or ~/.hive/auth_token).
if (!config.authToken()) {
  ensureAuthTokenConfigured();
  logger.info('auth', 'token_generated', {
    hint: 'A Hive auth token was generated on first boot. Paste the contents of ~/.hive/auth_token into the UI when prompted.',
  });
}

let ready = false;
let shuttingDown = false;
const { app, serveClient: SERVE_CLIENT } = createApp({ isReady: () => ready });
const server = http.createServer(app);

async function shutdown(reason = 'signal', exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  logger.info('process', 'shutdown_started', { reason });

  try { schedulerLifecycle.stopAll(); } catch (error) { logger.warn('process', 'scheduler_stop_failed', { error: error.message }); }
  try { require('./lib/colonyOutbox').stop(); } catch {}
  try { require('./lib/automationJobs').stop(); } catch {}
  try { require('./lib/databaseMaintenance').stop(); } catch {}
  try { await require('./lib/discord').stop(); } catch (error) { logger.warn('process', 'discord_stop_failed', { error: error.message }); }
  try { await ngrokService.stopTunnel(); } catch (error) { logger.warn('process', 'ngrok_stop_failed', { error: error.message }); }
  try {
    for (const id of Array.from(mcpManager.clients.keys())) mcpManager.disconnect(id);
  } catch (error) { logger.warn('process', 'mcp_stop_failed', { error: error.message }); }

  const force = setTimeout(() => {
    try { server.closeAllConnections?.(); } catch {}
    process.exit(exitCode);
  }, 8_000);
  force.unref?.();
  server.close(() => {
    clearTimeout(force);
    try { db.close(); } catch {}
    process.exit(exitCode);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM', 0));
process.once('SIGINT', () => shutdown('SIGINT', 0));

createWebSocketServer(server);

const PORT = config.port();
const HOST = config.bindHost();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('server', 'port_in_use', {
      port: PORT,
      hint: `Another process is listening on port ${PORT}. Stop it (or set PORT to a free port) and restart Hive.`,
    });
    process.exit(1);
  } else {
    throw err;
  }
});

server.listen(PORT, HOST, async () => {
  logger.info('server', 'listening', {
    port: PORT,
    host: HOST,
    ...(SERVE_CLIENT
      ? { url: `http://localhost:${PORT}` }
      : { hint: 'No client build found — run "npm run build" to serve the UI from this port, or use "npm run dev".' }),
  });
  // Attempt to auto-start ngrok
  const rowEnabled = db.prepare("SELECT value FROM app_settings WHERE key='ngrok_enabled'").get();
  if (rowEnabled && rowEnabled.value === 'true') {
    const authtoken = settingSecret('ngrok_authtoken', ['NGROK_AUTHTOKEN']);
    const rowDomain = db.prepare("SELECT value FROM app_settings WHERE key='ngrok_domain'").get();
    if (authtoken) {
      logger.info('ngrok', 'starting');
      try {
        assertCanExposePublicly();
        const url = await ngrokService.startTunnel({
          authtoken,
          domain: rowDomain?.value || null,
          port: PORT
        });
        logger.info('ngrok', 'tunnel_active', { url });
      } catch (e) {
        logger.error('ngrok', 'autostart_failed', { error: e.message });
      }
    }
  }

  // Colony execution is durable. A restarted process reclaims queued/leased
  // jobs instead of declaring every in-flight mission stopped.
  const recovered = require('./lib/colonyJobs').recover();
  if (recovered > 0) logger.info('startup', 'recovered_colony_runs', { count: recovered });
  const recoveredWebhookActions = require('./lib/webhookActions').recoverPendingActions();
  if (recoveredWebhookActions > 0) logger.info('startup', 'recovered_webhook_actions', { count: recoveredWebhookActions });
  const automationJobs = require('./lib/automationJobs');
  const recoveredAutomationJobs = automationJobs.recover();
  if (recoveredAutomationJobs > 0) logger.info('startup', 'recovered_automation_jobs', { count: recoveredAutomationJobs });
  automationJobs.start();
  require('./lib/colonyOutbox').start();
  require('./lib/databaseMaintenance').start();

  try {
    require('./lib/staffDirectory').seedStaffProfiles();
    schedulerLifecycle.startAll(['scheduler']);
    logger.info('startup', 'scheduler_lifecycle_done', { services: schedulerLifecycle.statuses() });
  } catch (e) {
    logger.error('startup', 'scheduler_lifecycle_failed', { error: e.message });
  }
  logger.info('startup', 'scheduler_done');
  try {
    await gatewayHealth.probeGateway({ force: true });
    logger.info('startup', 'gateway_health_done', { gateway: gatewayHealth.getGatewayStatus() });
  } catch (e) {
    logger.error('startup', 'gateway_health_failed', { error: e.message });
  }
  try {
    await mcpManager.loadAll();
    logger.info('startup', 'mcp_done');
  } catch (e) {
    logger.error('startup', 'mcp_failed', { error: e.message });
  }
  logger.info('startup', 'warming_sandbox');
  try {
    require('./lib/sandbox').warmImage();
    logger.info('startup', 'sandbox_done');
  } catch (e) {
    logger.error('startup', 'sandbox_failed', { error: e.message });
  }
  // Discord bridge (docs/specs/discord-bridge.md) — after MCP so the Steward
  // can offer connected MCP tool groups. No-ops without a bot token.
  try {
    const discord = require('./lib/discord');
    await discord.start();
    logger.info('startup', 'discord_done', { status: discord.status().state });
  } catch (e) {
    logger.error('startup', 'discord_failed', { error: e.message });
  }
  logger.info('startup', 'complete');
  ready = true;
});
