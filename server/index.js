const { logger } = require('./lib/logger');

process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection', { reason: reason?.message || String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('process', 'uncaughtException', { error: err?.message || String(err) });
});

const http = require('http');
const express = require('express');
const cors = require('cors');
const { createWebSocketServer } = require('./lib/websocket');
require('./lib/scheduler');
require('./lib/staffScheduler');
const schedulerLifecycle = require('./lib/schedulerLifecycle');
const mcpManager = require('./lib/mcpClient');
const ngrokService = require('./lib/ngrokService');
const db = require('./db');
const config = require('./lib/config');
const { settingSecret } = require('./lib/secrets');
const { logSwallowed } = require('./lib/logSwallowed');
const {
  assertCanExposePublicly,
  createCorsOptions,
  createMutatingRateLimiter,
  createOriginGuard,
  requireHiveAuth,
} = require('./lib/auth');

const app = express();
const server = http.createServer(app);

app.use(createOriginGuard());
app.use(cors(createCorsOptions()));
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
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
app.use('/api/staff', require('./routes/staff'));
app.use('/api/skills', require('./routes/skills'));
app.use('/api/system', require('./routes/system'));
app.use('/api/webhooks', require('./routes/webhooks'));

createWebSocketServer(server);

const PORT = config.port();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.warn('server', 'port_in_use', { port: PORT, action: 'killing existing process' });
    const { execSync } = require('child_process');
    try {
      execSync(`lsof -ti tcp:${PORT} | xargs kill -9`);
    } catch (e) { logSwallowed('server:killPortProcess', e, { port: PORT }); }
    setTimeout(() => server.listen(PORT), 500);
  } else {
    throw err;
  }
});

server.listen(PORT, async () => {
  logger.info('server', 'listening', { port: PORT });
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

  // Reset any colonies left in 'running' state from a previous crashed/restarted server
  const orphaned = db.prepare("UPDATE colonies SET status='stopped', updated_at=unixepoch() WHERE status='running'").run();
  if (orphaned.changes > 0) {
    logger.info('startup', 'reset_orphaned_runs', { count: orphaned.changes });
  }

  try {
    require('./lib/staffDirectory').seedStaffProfiles();
    schedulerLifecycle.startAll(['scheduler', 'staffScheduler']);
    logger.info('startup', 'scheduler_lifecycle_done', { services: schedulerLifecycle.statuses() });
  } catch (e) {
    logger.error('startup', 'scheduler_lifecycle_failed', { error: e.message });
  }
  logger.info('startup', 'scheduler_done');
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
  logger.info('startup', 'complete');
});
