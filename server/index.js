const http = require('http');
const express = require('express');
const cors = require('cors');
const { createWebSocketServer } = require('./lib/websocket');
const scheduler = require('./lib/scheduler');
const mcpManager = require('./lib/mcpClient');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

app.use('/api/agents', require('./routes/agents'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/ollama', require('./routes/ollama'));
app.use('/api/config', require('./routes/config'));
app.use('/api/pipelines', require('./routes/pipelines'));
app.use('/api/schedules', require('./routes/schedules'));
app.use('/api/mcp', require('./routes/mcp'));
app.use('/api/sandbox', require('./routes/sandbox'));
app.use('/api/colony', require('./routes/colony'));
app.use('/api/system', require('./routes/system'));

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
  console.log(`Hive server running on http://localhost:${PORT}`);

  // Reset any colonies left in 'running' state from a previous crashed/restarted server
  const db = require('./db');
  const orphaned = db.prepare("UPDATE colonies SET status='stopped', updated_at=unixepoch() WHERE status='running'").run();
  if (orphaned.changes > 0) {
    console.log(`Reset ${orphaned.changes} orphaned colony run(s) to 'stopped'`);
  }

  scheduler.loadAll();
  await mcpManager.loadAll();
  require('./lib/sandbox').warmImage();
});
