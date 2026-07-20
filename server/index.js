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
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
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
  createCorsOptions,
  createMutatingRateLimiter,
  createOriginGuard,
  ensureAuthTokenConfigured,
  requireHiveAuth,
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

const app = express();
const server = http.createServer(app);
let ready = false;
let shuttingDown = false;

async function shutdown(reason = 'signal', exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  logger.info('process', 'shutdown_started', { reason });

  try { schedulerLifecycle.stopAll(); } catch (error) { logger.warn('process', 'scheduler_stop_failed', { error: error.message }); }
  try { require('./lib/colonyOutbox').stop(); } catch {}
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

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:", "media-src 'self' blob:",
    "font-src 'self' data:", "connect-src 'self' ws: wss:",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
  ].join('; '));
  next();
});

app.use(createOriginGuard());
app.use(cors(createCorsOptions()));
app.use(express.json({
  limit: '100kb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
// Unauthenticated liveness probe. The desktop shell polls this to know when
// the server is ready; it exposes nothing beyond the app version.
app.get('/healthz', (req, res) => {
  res.json({ ok: true, version: require('../package.json').version });
});
app.get('/readyz', (req, res) => {
  res.status(ready ? 200 : 503).json({ ok: ready, version: require('../package.json').version });
});

app.use('/api', requireHiveAuth());
app.use('/api', createMutatingRateLimiter());

app.use('/api/agents', require('./routes/agents'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/ollama', require('./routes/ollama'));
app.use('/api/models', require('./routes/models'));
app.use('/api/config', require('./routes/config'));
app.use('/api/pipelines', require('./routes/pipelines'));
app.use('/api/schedules', require('./routes/schedules'));
app.use('/api/mcp', require('./routes/mcp'));
app.use('/api/sandbox', require('./routes/sandbox'));
app.use('/api/colony', require('./routes/colony'));
app.use('/api/artifacts', require('./routes/artifacts'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/skills', require('./routes/skills'));
app.use('/api/system', require('./routes/system'));
app.use('/api/webhooks', require('./routes/webhooks'));

// Serve the built client when it exists (production / desktop). In dev the
// Vite server owns the UI and proxies /api here, so this stays inert.
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
const SERVE_CLIENT = fs.existsSync(path.join(CLIENT_DIST, 'index.html'));
if (SERVE_CLIENT) {
  app.use(express.static(CLIENT_DIST));
  // SPA fallback so react-router deep links survive a reload. Express 5
  // rejects '*' route strings, hence plain middleware; unmatched /api and
  // /ws paths fall through to the default 404 instead.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  logger.error('http', 'request_failed', { method: req.method, path: req.path, error: err?.message || String(err) });
  return res.status(err?.status || 500).json({ error: err?.status && err.status < 500 ? err.message : 'Internal server error' });
});

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
