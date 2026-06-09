process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const http = require('http');
const express = require('express');
const cors = require('cors');
const { createWebSocketServer } = require('./lib/websocket');
const scheduler = require('./lib/scheduler');
const mcpManager = require('./lib/mcpClient');
const ngrokService = require('./lib/ngrokService');
const db = require('./db');
const { settingSecret } = require('./lib/secrets');
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

const PORT = process.env.PORT || 3001;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use, killing existing process...`);
    const { execSync } = require('child_process');
    try {
      execSync(`lsof -ti tcp:${PORT} | xargs kill -9`);
    } catch (_) {}
    setTimeout(() => server.listen(PORT), 500);
  } else {
    throw err;
  }
});

server.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  // Attempt to auto-start ngrok
  const rowEnabled = db.prepare("SELECT value FROM app_settings WHERE key='ngrok_enabled'").get();
  if (rowEnabled && rowEnabled.value === 'true') {
    const authtoken = settingSecret('ngrok_authtoken', ['NGROK_AUTHTOKEN']);
    const rowDomain = db.prepare("SELECT value FROM app_settings WHERE key='ngrok_domain'").get();
    if (authtoken) {
      console.log('Starting ngrok tunnel...');
      try {
        assertCanExposePublicly();
        const url = await ngrokService.startTunnel({
          authtoken,
          domain: rowDomain?.value || null,
          port: PORT
        });
        console.log(`Ngrok tunnel active at: ${url}`);
      } catch (e) {
        console.error('Failed to auto-start ngrok tunnel:', e.message);
      }
    }
  }

  // Reset any colonies left in 'running' state from a previous crashed/restarted server
  const orphaned = db.prepare("UPDATE colonies SET status='stopped', updated_at=unixepoch() WHERE status='running'").run();
  if (orphaned.changes > 0) {
    console.log(`Reset ${orphaned.changes} orphaned colony run(s) to 'stopped'`);
  }

  scheduler.loadAll();
  try {
    require('./lib/staffDirectory').seedStaffProfiles();
    require('./lib/staffScheduler').start();
    console.log('[startup] staff scheduler done');
  } catch (e) {
    console.error('[startup] staff scheduler failed:', e.message);
  }
  console.log('[startup] scheduler done');
  try {
    await mcpManager.loadAll();
    console.log('[startup] mcp done');
  } catch (e) {
    console.error('[startup] mcp failed:', e.message);
  }
  console.log('[startup] warming sandbox');
  try {
    require('./lib/sandbox').warmImage();
    console.log('[startup] sandbox done');
  } catch (e) {
    console.error('[startup] sandbox failed:', e.message);
  }
  console.log('[startup] complete');
});
