const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DEFAULT_LOCAL_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
  'http://[::1]:3000',
  'http://[::1]:3001',
  'http://[::1]:5173',
];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readSetting(key) {
  try {
    const db = require('../db');
    return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || '';
  } catch {
    return '';
  }
}

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function configuredAuthToken(options = {}) {
  if (options.token !== undefined) return options.token || '';
  return config.authToken();
}

function configuredAllowedOrigins(options = {}) {
  const extra = [
    ...splitList(config.allowedOriginsEnv()),
    ...splitList(readSetting('hive_allowed_origins')),
    ...splitList(options.allowedOrigins),
  ];
  return new Set([...DEFAULT_LOCAL_ORIGINS, ...extra]);
}

function normalizeIp(value = '') {
  if (!value) return '';
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value;
}

function isLoopbackHost(hostname = '') {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isLoopbackAddress(address = '') {
  const ip = normalizeIp(address);
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isAllowedOrigin(origin, options = {}) {
  if (!origin) return true;
  if (configuredAllowedOrigins(options).has(origin)) return true;
  try {
    const url = new URL(origin);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function getForwardedFor(req) {
  const value = req.headers?.['x-forwarded-for'];
  if (!value || Array.isArray(value)) return '';
  return value.split(',')[0].trim();
}

function getRemoteAddress(req) {
  return req.socket?.remoteAddress || req.connection?.remoteAddress || '';
}

function isLocalRequest(req, options = {}) {
  const forwardedFor = getForwardedFor(req);
  if (forwardedFor && !isLoopbackAddress(forwardedFor)) return false;
  return isLoopbackAddress(getRemoteAddress(req)) && isAllowedOrigin(req.headers?.origin, options);
}

function createWebhookRateLimiter(options = {}) {
  const limit = options.limit || config.webhookRateLimit();
  const windowMs = options.windowMs || config.webhookRateWindowMs();
  const maxBuckets = options.maxBuckets || 10_000;
  const buckets = new Map();

  return function webhookRateLimiter(req, res, next) {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now > bucket.resetAt) buckets.delete(key);
    }
    while (buckets.size > maxBuckets) buckets.delete(buckets.keys().next().value);

    const endpoint = String(req.params?.id || 'unknown');
    const identity = `${endpoint}:${getRemoteAddress(req) || 'unknown'}`;
    const bucket = buckets.get(identity);
    if (!bucket || now > bucket.resetAt) {
      buckets.set(identity, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Too many webhook deliveries; retry later' });
    }
    next();
  };
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function extractAuthToken(req) {
  const auth = req.headers?.authorization || '';
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const headerToken = req.headers?.['x-hive-auth-token'];
  if (typeof headerToken === 'string') return headerToken.trim();
  const protocols = String(req.headers?.['sec-websocket-protocol'] || '').split(',').map(v => v.trim());
  const encoded = protocols.find(value => value.startsWith('hive-auth.'))?.slice('hive-auth.'.length);
  if (encoded) {
    try { return Buffer.from(encoded, 'base64url').toString('utf8').trim(); } catch { return ''; }
  }
  return '';
}

function hasValidAuth(req, options = {}) {
  const expected = configuredAuthToken(options);
  if (!expected) {
    // No token configured (should only happen if the user cleared it — first
    // boot generates one). Fall back to loopback-only access, but refuse
    // state-changing requests that carry no Origin header: those are not
    // browser requests from the local UI, they're arbitrary local processes.
    if (MUTATING_METHODS.has(req.method) && !req.headers?.origin) return false;
    return isLocalRequest(req, options);
  }
  const actual = extractAuthToken(req);
  return !!actual && timingSafeEqualString(actual, expected);
}

// First-boot token bootstrap: if no auth token is configured via env or the
// hive_auth_token setting, generate a random one, persist it, and drop a copy
// at <HIVE_HOME>/auth_token (0600) so the local user can paste it into the UI.
// Returns the active token.
function ensureAuthTokenConfigured() {
  const existing = config.authToken();
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('base64url');
  const db = require('../db');
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('hive_auth_token', token);
  config.invalidateSettingsCache('hive_auth_token');
  try {
    const tokenFile = path.join(config.hiveHome(), 'auth_token');
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  } catch { /* best-effort convenience copy; the DB row is authoritative */ }
  return token;
}

function isIncomingWebhook(req) {
  return (req.originalUrl || req.url || '').startsWith('/api/webhooks/incoming/');
}

function createOriginGuard(options = {}) {
  return function originGuard(req, res, next) {
    if (!isAllowedOrigin(req.headers.origin, options)) {
      return res.status(403).json({ error: 'Origin is not allowed by Hive CORS policy' });
    }
    next();
  };
}

function createCorsOptions(options = {}) {
  return {
    origin(origin, callback) {
      callback(null, origin && isAllowedOrigin(origin, options) ? origin : false);
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-hive-auth-token'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  };
}

function requireHiveAuth(options = {}) {
  return function hiveAuth(req, res, next) {
    if (req.method === 'OPTIONS' || isIncomingWebhook(req)) return next();
    if (hasValidAuth(req, options)) return next();
    res.status(401).json({ error: 'Hive authentication is required' });
  };
}

function createMutatingRateLimiter(options = {}) {
  const limit = options.limit || config.mutationRateLimit();
  const windowMs = options.windowMs || config.mutationRateWindowMs();
  const maxBuckets = options.maxBuckets || 10_000;
  const buckets = new Map();
  let lastSweepAt = 0;

  // The map would otherwise grow one entry per distinct IP/token forever (a
  // real leak behind ngrok). Sweep expired windows at most once per window,
  // and hard-cap the map by evicting the oldest entries.
  function sweep(now) {
    if (now - lastSweepAt < windowMs && buckets.size <= maxBuckets) return;
    lastSweepAt = now;
    for (const [key, bucket] of buckets) {
      if (now > bucket.resetAt) buckets.delete(key);
    }
    while (buckets.size > maxBuckets) {
      buckets.delete(buckets.keys().next().value);
    }
  }

  return function mutatingRateLimiter(req, res, next) {
    if (!MUTATING_METHODS.has(req.method) || isIncomingWebhook(req)) return next();

    const now = Date.now();
    sweep(now);
    const token = extractAuthToken(req);
    const identity = token ? `token:${crypto.createHash('sha256').update(token).digest('hex')}` : `ip:${getRemoteAddress(req)}`;
    const bucket = buckets.get(identity);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(identity, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many mutating requests; slow down and retry shortly' });
    }

    next();
  };
}

function assertCanExposePublicly(options = {}) {
  if (!configuredAuthToken(options)) {
    throw new Error('Hive auth must be configured with HIVE_AUTH_TOKEN or hive_auth_token before starting ngrok');
  }
}

function rejectSocket(socket, statusCode, message) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain\r\n' +
    `Content-Length: ${Buffer.byteLength(message)}\r\n` +
    '\r\n' +
    message
  );
  socket.destroy();
}

module.exports = {
  DEFAULT_LOCAL_ORIGINS,
  assertCanExposePublicly,
  configuredAuthToken,
  ensureAuthTokenConfigured,
  createCorsOptions,
  createMutatingRateLimiter,
  createWebhookRateLimiter,
  createOriginGuard,
  hasValidAuth,
  isAllowedOrigin,
  isLocalRequest,
  rejectSocket,
  requireHiveAuth,
  timingSafeEqualString,
};
