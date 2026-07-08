// Shared helper for HTTP route tests (issue #47). Builds a minimal Express app
// with the same JSON body parsing as production (incl. rawBody capture, which
// webhook signature verification relies on) and mounts one router at its prefix.
// Deliberately does NOT import server/index.js — that would start schedulers,
// the WebSocket server, ngrok, MCP, and sandbox warming.
const express = require('express');

function makeApp(router, prefix) {
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use(prefix, router);
  return app;
}

module.exports = { makeApp };
