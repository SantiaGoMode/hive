// Per-run artifact store. Repo-backed colonies commit their outputs to git, but
// repo-less colonies (research, media generation, analysis) had nowhere durable
// to put files — generated images, audio, and reports would live only inside an
// agent's ephemeral sandbox. This gives every run a canonical directory:
//   <HIVE_HOME>/artifacts/<colonyId>/
// Media tools write here, the report is mirrored here, the colony overview
// serves downloads from here, and the Discord relay uploads these as file
// attachments. Filenames are sanitized and confined to the run's own directory.
const fs = require('fs');
const path = require('path');
const config = require('./config');

function artifactsRoot() {
  return path.join(config.hiveHome(), 'artifacts');
}

// The validated path for a bucket (a colony id, or an adhoc-<agentId> bucket for
// non-colony agents). Does NOT create the directory — safe for read paths.
function bucketDir(bucket) {
  const id = String(bucket || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid artifacts bucket');
  return path.join(artifactsRoot(), id);
}

// The run's directory, created on demand (write path).
function artifactsDir(colonyId) {
  const dir = bucketDir(colonyId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Reduce a model-proposed name to a safe basename inside the run dir. Keeps the
// extension, strips any path components, and de-duplicates on collision.
function safeFilename(name, fallbackExt = '') {
  let base = path.basename(String(name || '').trim()).replace(/[^a-zA-Z0-9._-]/g, '_');
  base = base.replace(/^\.+/, '').slice(0, 120);
  if (!base) base = `artifact${fallbackExt}`;
  if (fallbackExt && !path.extname(base)) base += fallbackExt;
  return base;
}

function uniquePath(dir, filename) {
  let candidate = path.join(dir, filename);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

// Persist bytes as a run artifact. Returns { name, path, bytes } where `name`
// is the basename to reference in deliverables (paths are relative to the run
// dir, so the same string resolves for the viewer and Discord upload).
function saveArtifact(colonyId, filename, data, { ext = '' } = {}) {
  const dir = artifactsDir(colonyId);
  const target = uniquePath(dir, safeFilename(filename, ext));
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  fs.writeFileSync(target, buf);
  return { name: path.basename(target), path: path.basename(target), bytes: buf.length };
}

// Resolve a relative artifact name to an absolute path, refusing traversal.
// Read-safe: does not create the bucket directory.
function resolveArtifact(bucket, name) {
  const dir = bucketDir(bucket);
  const resolved = path.resolve(dir, String(name || ''));
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error('Artifact path escapes the artifacts directory');
  }
  return resolved;
}

// List files in the run dir with size + mime hint. Directories are flattened one
// level (media tools write flat, but be forgiving).
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.html': 'text/html',
};

function mimeFor(name) {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

// Remove a run's entire artifact bucket from disk. Best-effort and idempotent:
// missing directories are fine. Used when a colony run is deleted so its
// generated files don't orphan under <HIVE_HOME>/artifacts/.
function deleteBucket(bucket) {
  let dir;
  try { dir = bucketDir(bucket); } catch { return false; }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function listArtifacts(colonyId) {
  let dir;
  try { dir = bucketDir(colonyId); } catch { return []; }
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    let size = 0;
    try { size = fs.statSync(path.join(dir, e.name)).size; } catch { /* stat best-effort */ }
    out.push({ name: e.name, size, mime: mimeFor(e.name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  artifactsRoot,
  bucketDir,
  artifactsDir,
  safeFilename,
  saveArtifact,
  resolveArtifact,
  listArtifacts,
  deleteBucket,
  mimeFor,
};
