const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { logger } = require('./lib/logger');
const {
  createCorsOptions,
  createMutatingRateLimiter,
  createOriginGuard,
  requireHiveAuth,
} = require('./lib/auth');

const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

function securityHeaders(req, res, next) {
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
}

function createApp({ isReady = () => false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(createOriginGuard());
  app.use(cors(createCorsOptions()));
  app.use(express.json({
    limit: '100kb',
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));

  const version = require('../package.json').version;
  app.get('/healthz', (req, res) => res.json({ ok: true, version }));
  app.get('/readyz', (req, res) => {
    const ready = Boolean(isReady());
    res.status(ready ? 200 : 503).json({ ok: ready, version });
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

  const serveClient = fs.existsSync(path.join(CLIENT_DIST, 'index.html'));
  if (serveClient) {
    app.use(express.static(CLIENT_DIST));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      return res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    logger.error('http', 'request_failed', { method: req.method, path: req.path, error: err?.message || String(err) });
    return res.status(err?.status || 500).json({ error: err?.status && err.status < 500 ? err.message : 'Internal server error' });
  });

  return { app, serveClient };
}

module.exports = { createApp, securityHeaders };
