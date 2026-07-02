const { execSync, spawn } = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const config = require('./config');

const HIVE_DIR     = process.env.HIVE_HOME || path.join(os.homedir(), '.hive');
const IMAGE        = 'hive-sandbox:latest';
const FALLBACK_IMG = 'python:3.11-slim';
const EXEC_TIMEOUT = 60_000; // ms
// Ports published from every sandbox container (container-side)
const PUBLISHED_PORTS = [3000, 5000, 8000, 8080];

// in-memory port map: agentId → { containerPort: hostPort }
const _portCache = {};

// agentId → { path, writable } for the repo to mount as the agent's /workspace.
// Set by the colony runner for coding workers so they edit the real project,
// not an empty scratch dir. When unset, the agent gets its private sandbox dir.
// Repo mounts are read-only unless the caller explicitly opts into writes.
const _repoMounts = {};

function setAgentRepo(agentId, repoPath, options = {}) {
  validateAgentId(agentId);
  if (repoPath && fs.existsSync(repoPath)) {
    const real = fs.realpathSync(repoPath);
    if (!fs.statSync(real).isDirectory()) throw new Error('Sandbox repo path must be an existing directory');
    _repoMounts[agentId] = { path: real, writable: !!options.writable };
  }
  else delete _repoMounts[agentId];
}

// What the workspace volume should be for this agent (repo if assigned + exists).
function workspaceDir(agentId) {
  const repo = _repoMounts[agentId];
  if (repo && fs.existsSync(repo.path)) return repo.path;
  return sandboxDir(agentId);
}

function workspaceMount(agentId) {
  const repo = _repoMounts[agentId];
  if (repo && fs.existsSync(repo.path)) {
    return { dir: repo.path, readOnly: !repo.writable };
  }
  return { dir: sandboxDir(agentId), readOnly: false };
}

// agentId → network mode override ('bridge'). Set by the colony runner for
// coding workers, which need egress for npm/pip installs.
const _networkOpts = {};

function setAgentNetwork(agentId, mode) {
  validateAgentId(agentId);
  if (mode === 'bridge') _networkOpts[agentId] = 'bridge';
  else delete _networkOpts[agentId];
}

// Sandbox network mode. Default is no network at all — a prompt-injected model
// must not get free egress. Coding workers are opted into bridge per-agent by
// the colony runner; HIVE_SANDBOX_NETWORK=bridge / the sandbox_network app
// setting opts in globally.
function sandboxNetwork(agentId = null) {
  if (agentId && _networkOpts[agentId] === 'bridge') return 'bridge';
  const raw = String(process.env.HIVE_SANDBOX_NETWORK || config.getSetting('sandbox_network') || '').trim().toLowerCase();
  return raw === 'bridge' ? 'bridge' : 'none';
}

// Report sandbox capability so the colony can tell the user up front whether
// real coding is possible (Docker running + image available).
function capabilities() {
  const docker = isDockerAvailable();
  if (!docker) {
    return { docker: false, ready: false, message: 'Docker is not available or not running. Coding agents cannot build/run code until Docker is started.' };
  }
  const img = imageExists(IMAGE) ? IMAGE : (imageExists(FALLBACK_IMG) ? FALLBACK_IMG : null);
  return {
    docker: true,
    ready: !!img,
    image: img,
    message: img ? `Sandbox ready (image: ${img}).` : `Docker is running but no sandbox image is built yet; it will build on first use.`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function containerName(agentId) {
  return `hive-sandbox-${safeAgentId(agentId)}`;
}

function sandboxDir(agentId) {
  const dir = path.join(HIVE_DIR, 'agents', safeAgentId(agentId), 'sandbox');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function validateAgentId(agentId) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(String(agentId || ''))) {
    throw new Error('Invalid sandbox agent id');
  }
}

function safeAgentId(agentId) {
  validateAgentId(agentId);
  return String(agentId);
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function stripWorkspacePrefix(userPath) {
  return String(userPath || '').replace(/^\/?(?:workspace\/)+/, '');
}

function nearestExistingPath(candidate, root) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return root;
    current = parent;
  }
  return current;
}

function resolveWorkspacePath(workspaceRoot, userPath, options = {}) {
  if (!userPath || typeof userPath !== 'string') throw new Error('path required');
  if (userPath.includes('\0')) throw new Error('Sandbox path contains an invalid character');

  const root = fs.realpathSync(workspaceRoot);
  const rel = options.stripWorkspacePrefix === false ? userPath : stripWorkspacePrefix(userPath);
  if (path.isAbsolute(rel)) throw new Error('Sandbox path must be relative to /workspace');

  const candidate = path.resolve(root, rel);
  if (!isInside(root, candidate)) throw new Error('Sandbox path must stay inside /workspace');

  const existing = fs.existsSync(candidate) ? candidate : nearestExistingPath(candidate, root);
  const realExisting = fs.realpathSync(existing);
  if (!isInside(root, realExisting)) throw new Error('Sandbox path must stay inside /workspace');

  if (!options.allowMissing && !fs.existsSync(candidate)) throw new Error(`Sandbox path not found: ${userPath}`);
  if (fs.existsSync(candidate)) {
    const realCandidate = fs.realpathSync(candidate);
    if (!isInside(root, realCandidate)) throw new Error('Sandbox path must stay inside /workspace');
    return realCandidate;
  }

  return candidate;
}

function listWorkspaceFiles(agentId, directory = '.', options = {}) {
  const root = workspaceDir(agentId);
  const start = resolveWorkspacePath(root, directory, { allowMissing: false });
  const maxDepth = options.maxDepth ?? 3;
  const limit = options.limit ?? 100;
  const files = [];

  function walk(absPath, depth) {
    if (files.length >= limit || depth > maxDepth) return;
    const entries = fs.statSync(absPath).isDirectory()
      ? fs.readdirSync(absPath, { withFileTypes: true })
      : [];

    for (const entry of entries) {
      if (files.length >= limit) break;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
      const child = path.join(absPath, entry.name);
      const rel = path.relative(root, child);
      files.push(rel);
      if (entry.isDirectory()) walk(child, depth + 1);
    }
  }

  if (fs.statSync(start).isDirectory()) walk(start, 1);
  else files.push(path.relative(root, start));

  return files.sort();
}

// `docker info` can block for seconds when the daemon is slow, and this runs
// inside request handlers — cache the probe so the event loop isn't repeatedly
// frozen on it. Sticky-true: under heavy load (Ollama pegging the machine) the
// probe TIMES OUT while docker is perfectly healthy, and a transient false
// failed agents' shell calls mid-run with "Docker is not available". Once
// docker has been seen up, keep trusting it — a genuinely dead daemon surfaces
// as a clear error on the actual `docker exec` instead.
const DOCKER_PROBE_TTL = 5_000; // ms
let _dockerProbe = { at: 0, ok: false, everOk: false };

function isDockerAvailable() {
  const now = Date.now();
  if (now - _dockerProbe.at < DOCKER_PROBE_TTL) return _dockerProbe.ok;
  let ok;
  try { execSync('docker info', { stdio: 'ignore', timeout: 10_000 }); ok = true; }
  catch { ok = _dockerProbe.everOk; /* transient probe failure — trust history */ }
  _dockerProbe = { at: now, ok, everOk: _dockerProbe.everOk || ok };
  return ok;
}

function containerStatus(agentId) {
  try {
    return execSync(
      `docker inspect --format '{{.State.Status}}' ${containerName(agentId)}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch { return 'missing'; }
}

// ── Image management ──────────────────────────────────────────────────────────

function imageExists(tag) {
  try {
    execSync(`docker image inspect ${tag}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function buildImage() {
  const dockerfilePath = path.join(__dirname, 'Dockerfile.sandbox');
  if (!fs.existsSync(dockerfilePath)) return false;
  console.log('[sandbox] Building hive-sandbox image (one-time setup, this may take a minute)…');
  try {
    execSync(`docker build -t ${IMAGE} -f "${dockerfilePath}" "${__dirname}"`, { stdio: 'inherit' });
    console.log('[sandbox] Image built successfully.');
    return true;
  } catch (e) {
    console.error('[sandbox] Image build failed, falling back to python:3.11-slim', e.message);
    return false;
  }
}

function resolveImage() {
  if (imageExists(IMAGE)) return IMAGE;
  if (buildImage()) return IMAGE;
  return FALLBACK_IMG;
}

// ── Port mapping ──────────────────────────────────────────────────────────────

function loadPortMap(agentId) {
  if (_portCache[agentId]) return _portCache[agentId];
  try {
    const raw = execSync(
      `docker inspect --format '{{json .NetworkSettings.Ports}}' ${containerName(agentId)}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const ports = JSON.parse(raw);
    const map = {};
    for (const [key, bindings] of Object.entries(ports || {})) {
      const containerPort = parseInt(key);
      const hostPort      = bindings?.[0]?.HostPort ? parseInt(bindings[0].HostPort) : null;
      if (hostPort) map[containerPort] = hostPort;
    }
    _portCache[agentId] = map;
    return map;
  } catch { return {}; }
}

function hostPort(agentId, containerPort) {
  return loadPortMap(agentId)[containerPort] ?? null;
}

// ── Container lifecycle ───────────────────────────────────────────────────────

async function ensureContainer(agentId) {
  validateAgentId(agentId);
  if (!isDockerAvailable()) throw new Error('Docker is not available or not running');
  const name   = containerName(agentId);
  const mount  = workspaceMount(agentId);
  const status = containerStatus(agentId);

  if (status === 'running') return mount.dir;

  if (status === 'exited' || status === 'created') {
    execSync(`docker start ${name}`, { stdio: 'ignore' });
    delete _portCache[agentId]; // re-read ports
    return mount.dir;
  }

  // Create a fresh container. Locked down by default: no capabilities, no
  // privilege escalation, no network. Port publishing only makes sense when
  // networking is enabled.
  const image   = resolveImage();
  const network = sandboxNetwork(agentId);
  const portArgs = network === 'none' ? '' : PUBLISHED_PORTS.map(p => `-p 0:${p}`).join(' ');
  execSync([
    'docker run -d',
    `--name ${name}`,
    `--label hive-sandbox=true`,
    `--label hive-agent-id=${agentId}`,
    `-v "${mount.dir}:/workspace${mount.readOnly ? ':ro' : ''}"`,
    `-w /workspace`,
    portArgs,
    `--memory=512m`,
    `--cpus=1.0`,
    `--network=${network}`,
    `--pids-limit=200`,
    `--cap-drop=ALL`,
    `--security-opt no-new-privileges`,
    image,
  ].join(' ').replace(/\s+/g, ' '), { stdio: 'ignore' });

  delete _portCache[agentId];
  return mount.dir;
}

// ── Command execution ─────────────────────────────────────────────────────────

async function exec(agentId, cmd, timeoutMs = EXEC_TIMEOUT, options = {}) {
  validateAgentId(agentId);
  await ensureContainer(agentId);
  const timeoutSecs = Math.max(1, Math.round(timeoutMs / 1000));
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    // The timeout must kill the process INSIDE the container — killing the
    // local `docker exec` client leaves npm/pip running as a zombie in the
    // container. coreutils `timeout` (present in debian-slim) enforces it
    // in-container; the JS timer below is only a backstop for a wedged docker
    // CLI. CI=1 keeps interactive tools (create-next-app etc.) from hanging
    // on prompts nothing will ever answer.
    const runArgs = ['timeout', '-k', '5', String(timeoutSecs), 'bash', '-c', cmd];
    // -i only when piping stdin: large payloads (e.g. run_python source) go
    // through stdin instead of the command string, which is capped by ARG_MAX.
    const args = options.input != null
      ? ['exec', '-i', '-e', 'CI=1', containerName(agentId), ...runArgs]
      : ['exec', '-e', 'CI=1', containerName(agentId), ...runArgs];
    const proc  = spawn('docker', args);
    if (options.input != null) {
      proc.stdin.on('error', () => {}); /* container may exit before the write completes */
      proc.stdin.write(options.input);
      proc.stdin.end();
    }
    const timedOutMsg = `\n[timed out after ${timeoutSecs}s]`;
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr: stderr + timedOutMsg, exitCode: 124 });
    }, timeoutMs + 10_000); // backstop only; in-container timeout fires first

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 124) return resolve({ stdout, stderr: stderr + timedOutMsg, exitCode: 124 });
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    proc.on('error', err => { clearTimeout(timer); resolve({ stdout: '', stderr: err.message, exitCode: -1 }); });
  });
}

// Background exec — returns immediately with the pid
async function execBackground(agentId, cmd, logFile = '/tmp/hive_server.log') {
  await ensureContainer(agentId);
  const wrapped = `nohup bash -c ${JSON.stringify(cmd)} > ${logFile} 2>&1 & echo $!`;
  const { stdout } = await exec(agentId, wrapped);
  return parseInt(stdout.trim()) || null;
}

// ── Status & info ─────────────────────────────────────────────────────────────

function getStatus(agentId) {
  validateAgentId(agentId);
  if (!isDockerAvailable()) return { docker: false, status: 'docker-unavailable' };
  const status = containerStatus(agentId);
  const ports  = status === 'running' ? loadPortMap(agentId) : {};
  return { docker: true, status, ports };
}

async function reset(agentId) {
  validateAgentId(agentId);
  try { execSync(`docker rm -f ${containerName(agentId)}`, { stdio: 'ignore' }); } catch {} /* teardown: container may not exist */
  delete _portCache[agentId];
  delete _repoMounts[agentId];
  delete _networkOpts[agentId];
  const dir = path.join(HIVE_DIR, 'agents', safeAgentId(agentId), 'sandbox');
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function cleanupContainer(agentId) {
  if (!agentId || !isDockerAvailable()) return false;
  const status = containerStatus(agentId);
  if (status === 'missing') {
    delete _portCache[agentId];
    delete _repoMounts[agentId];
    delete _networkOpts[agentId];
    return false;
  }
  try {
    execSync(`docker rm -f ${containerName(agentId)}`, { stdio: 'ignore' });
    delete _portCache[agentId];
    delete _repoMounts[agentId];
    delete _networkOpts[agentId];
    return true;
  } catch {
    return false;
  }
}

// Pre-build the image in the background at startup if not present
function warmImage() {
  if (!isDockerAvailable()) return;
  if (!imageExists(IMAGE)) {
    setTimeout(() => buildImage(), 2000);
  }
}

module.exports = {
  ensureContainer, exec, execBackground,
  getStatus, reset,
  setAgentRepo, setAgentNetwork, capabilities, workspaceDir, workspaceMount, sandboxNetwork,
  sandboxDir, hostPort, loadPortMap,
  isDockerAvailable, containerName,
  resolveWorkspacePath, listWorkspaceFiles,
  cleanupContainer,
  warmImage,
};
