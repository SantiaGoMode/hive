// Colony run read routes: fetch a run, serve deliverable artifacts, edit
// trigger routing, and the resumable SSE tail. Registered after the fixed
// /teams routes so these dynamic /:id routes don't shadow them.
const { getColony } = require('../../lib/colonyRunner');
const { getBus, hasBus, maybeCleanup } = require('../../lib/colonyBus');
const { normalizeTriggerConfig } = require('../../lib/colonyTriggers');
const db = require('../../db');
const { fs, sseHeaders, sseWrite, getColonyRepoPath } = require('./shared');

// Artifacts are file paths relative to the run's repo; this serves their
// content (text only, size-capped, traversal-safe) so the UI can show them.
const ARTIFACT_MAX_BYTES = 256 * 1024;

module.exports = function registerRunReadRoutes(router) {
  // GET /api/colony/:id
  router.get('/:id', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    res.json(colony);
  });

  // GET /api/colony/:id/artifact?path=relative/file — open a deliverable artifact.
  router.get('/:id/artifact', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    const rel = String(req.query.path || '').trim();
    if (!rel) return res.status(400).json({ error: 'path is required' });
    const repoPath = colony.repo_path || getColonyRepoPath();
    if (!repoPath) return res.status(400).json({ error: 'This run has no repository path to resolve artifacts against.' });

    const path = require('path');
    // realpath the repo root so a symlinked repo path still compares correctly.
    let root;
    try { root = fs.realpathSync(path.resolve(repoPath)); } catch { root = path.resolve(repoPath); }
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return res.status(400).json({ error: 'Artifact path escapes the run repository.' });
    }
    let stat;
    try { stat = fs.statSync(resolved); } catch { stat = null; }

    // Defeat symlink escapes: a colony worker can write the repo, so it could
    // drop a symlink (docs/x -> ~/.ssh/id_rsa) that statSync happily follows.
    // Resolve the real path and re-check containment before reading anything.
    if (stat) {
      let realResolved;
      try { realResolved = fs.realpathSync(resolved); } catch { realResolved = resolved; }
      if (realResolved !== root && !realResolved.startsWith(root + path.sep)) {
        return res.status(400).json({ error: 'Artifact path escapes the run repository.' });
      }
    }

    // Not in the working tree — the run committed it to its own branch
    // (colony-<id>) which may not be checked out. Read it from git instead.
    if (!stat) {
      const { execFileSync } = require('child_process');
      const relPosix = rel.split(path.sep).join('/');
      const branch = `colony-${colony.id}`;
      for (const ref of [branch, `origin/${branch}`]) {
        try {
          const buf = execFileSync('git', ['-C', root, 'show', `${ref}:${relPosix}`], {
            maxBuffer: ARTIFACT_MAX_BYTES + 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          if (buf.includes(0)) {
            return res.status(415).json({ error: `"${rel}" is a binary file — open it from the repo directly.` });
          }
          const truncated = buf.length > ARTIFACT_MAX_BYTES;
          return res.json({
            path: rel,
            size: buf.length,
            truncated,
            source: `git branch ${ref}`,
            content: buf.slice(0, ARTIFACT_MAX_BYTES).toString('utf8'),
          });
        } catch {
          // try the next ref
        }
      }
      return res.status(404).json({ error: `Artifact not found in the working tree or on the run's branch (${branch}): ${rel}. It may have been moved or the branch deleted.` });
    }

    if (!stat.isFile()) return res.status(400).json({ error: 'Artifact path is not a file' });

    const truncated = stat.size > ARTIFACT_MAX_BYTES;
    const fd = fs.openSync(resolved, 'r');
    let buf;
    try {
      buf = Buffer.alloc(Math.min(stat.size, ARTIFACT_MAX_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (buf.includes(0)) {
      return res.status(415).json({ error: `"${rel}" is a binary file (${stat.size} bytes) — open it from the repo directly.` });
    }
    res.json({ path: rel, size: stat.size, truncated, content: buf.toString('utf8') });
  });

  // PUT /api/colony/:id/triggers — edit per-colony webhook routing.
  router.put('/:id/triggers', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });
    const triggerConfig = normalizeTriggerConfig(req.body?.trigger_config || req.body || null);
    const shouldClear = !triggerConfig?.webhook_id && (!triggerConfig?.event_types || triggerConfig.event_types.length === 0);
    db.prepare('UPDATE colonies SET trigger_config=?, updated_at=unixepoch() WHERE id=?')
      .run(shouldClear ? null : JSON.stringify(triggerConfig), colony.id);
    res.json({ success: true, trigger_config: shouldClear ? null : triggerConfig });
  });

  // GET /api/colony/:id/stream — resumable SSE tail.
  // Replays log entries from the DB with seq > ?since= (default 0), then
  // attaches to the per-colony event bus for live updates if the run is still
  // ongoing. Safe to open from multiple tabs at once and safe to reopen after
  // a browser refresh.
  router.get('/:id/stream', (req, res) => {
    const colony = getColony(req.params.id);
    if (!colony) return res.status(404).json({ error: 'Colony not found' });

    sseHeaders(res);
    sseWrite(res, { type: 'colony_id', colonyId: colony.id });

    const since = parseInt(req.query.since || '0', 10) || 0;

    // Replay historical entries (already persisted).
    let lastSentSeq = since;
    const historical = Array.isArray(colony.log) ? colony.log : [];
    for (const entry of historical) {
      const seq = entry.seq || 0;
      if (seq > since) {
        sseWrite(res, { type: 'log_entry', entry });
        if (seq > lastSentSeq) lastSentSeq = seq;
      }
    }

    // Also replay agent_ready-style synthetic events for each historical agent_ready
    // log entry so the client color map / filter chips work without extra parsing.
    for (const entry of historical) {
      if (entry.kind === 'agent_ready' && entry.agent) {
        sseWrite(res, { type: 'agent_ready', role: entry.role, agent: entry.agent });
      }
    }

    // If the run is no longer active, close immediately.
    if (colony.status !== 'running' || !hasBus(colony.id)) {
      sseWrite(res, { type: 'done', status: colony.status });
      res.end();
      return;
    }

    // Otherwise attach to the live bus. Filter out log_entry events we've already
    // sent historically, so clients don't see duplicates across the handoff.
    const bus = getBus(colony.id);
    const listener = (event) => {
      if (event.type === 'log_entry' && event.entry?.seq && event.entry.seq <= lastSentSeq) {
        return;
      }
      if (event.type === 'log_entry' && event.entry?.seq > lastSentSeq) {
        lastSentSeq = event.entry.seq;
      }
      sseWrite(res, event);
    };
    bus.on('event', listener);

    res.on('close', () => {
      bus.off('event', listener);
      maybeCleanup(colony.id);
    });
  });
};
