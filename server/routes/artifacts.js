// Generic artifact serving from <HIVE_HOME>/artifacts/<bucket>/. A bucket is a
// colony run id OR an `adhoc-<agentId>` bucket for media produced by a regular
// (non-colony) agent. This is what lets media generated in normal chat be
// viewed/downloaded — the colony-scoped /api/colony/:id/artifact route only
// resolves real colony runs. Auth is applied by the /api requireHiveAuth guard;
// browser elements consume these through an authenticated fetch + Blob URL.
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const artifacts = require('../lib/colonyArtifacts');

// GET /api/artifacts/:bucket — list files in a bucket.
router.get('/:bucket', (req, res) => {
  res.json({ bucket: req.params.bucket, artifacts: artifacts.listArtifacts(req.params.bucket) });
});

// GET /api/artifacts/:bucket/:name — stream a file's bytes (inline; ?download=1
// forces an attachment). Path-safe: the name cannot escape the bucket.
router.get('/:bucket/:name', (req, res) => {
  let abs;
  try { abs = artifacts.resolveArtifact(req.params.bucket, req.params.name); }
  catch { return res.status(400).json({ error: 'Invalid artifact path' }); }
  let stat;
  try { stat = fs.statSync(abs); } catch { stat = null; }
  if (!stat || !stat.isFile()) return res.status(404).json({ error: 'Artifact not found' });
  res.setHeader('Content-Type', artifacts.mimeFor(abs));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const activeContent = /\.(?:html?|svg)$/i.test(abs);
  const disposition = req.query.download === '1' || activeContent ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename="${path.basename(abs)}"`);
  fs.createReadStream(abs).pipe(res);
});

module.exports = router;
