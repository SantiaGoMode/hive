// Shared state and helpers for the colony route modules.
//
// routes/colony.js was split into focused modules under this directory. They all
// register handlers on the SAME express router (see ./index.js), so the mounted
// path (/api/colony) and route declaration order are preserved exactly. This
// module holds the cross-cutting pieces those handlers share: the process-global
// active-run registry, SSE plumbing, repo-path settings, and small helpers.
const fs = require('fs');
const protocol = require('../../lib/colonyProtocol');
const db = require('../../db');

// Resolve a colony's seeded agents back to their protocol role keys by matching
// each agent's persona_role to the role metadata for the colony's recipe. Used
// to attach live agent_ids to the A2A ID cards.
function roleKeyForAgent(recipeId, agent) {
  if (!protocol.getFlow(recipeId) || !agent) return null;
  for (const [key, m] of Object.entries(protocol.DEV_TEAM_ROLES)) {
    if (m.role === agent.persona_role || m.name === agent.name) return key;
  }
  return null;
}

// "owner/repo" → { owner, repo } for write-back when no local repo path is set.
function parseRepoSlug(slug) {
  const m = String(slug || '').match(/^([^/]+)\/(.+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Active AbortControllers keyed by colonyId. This map is process-global for all
// run routes (start, stop, delete, bootstrap accept) so it must be shared across
// the route modules rather than re-created per module.
const activeRuns = new Map();

// Wall-clock safety cap. If a colony run hasn't finished in this many ms, we
// abort it. Prevents a stuck model or a worker agent in an infinite tool loop
// from pinning resources forever. Tuned generously — a full dev-team flow is
// six roles each doing real tool work on a local model; 15 minutes was
// routinely killing runs at ~2 of 7 plan steps.
const COLONY_MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// SSE plumbing shared between POST / and GET /:id/stream.
function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering if any
  res.flushHeaders();
}

function sseWrite(res, data) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function getColonyRepoPath() {
  return db.prepare("SELECT value FROM app_settings WHERE key='colony_repo_path'").get()?.value || '';
}

function setColonyRepoPath(repoPath) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('colony_repo_path', repoPath);
}

module.exports = {
  fs,
  roleKeyForAgent,
  parseRepoSlug,
  activeRuns,
  COLONY_MAX_DURATION_MS,
  sseHeaders,
  sseWrite,
  getColonyRepoPath,
  setColonyRepoPath,
};
