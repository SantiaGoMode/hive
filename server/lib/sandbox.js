const { execSync, spawn } = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');

const HIVE_DIR     = path.join(os.homedir(), '.hive');
const IMAGE        = 'hive-sandbox:latest';
const FALLBACK_IMG = 'python:3.11-slim';
const EXEC_TIMEOUT = 60_000; // ms
// Ports published from every sandbox container (container-side)
const PUBLISHED_PORTS = [3000, 5000, 8000, 8080];

// in-memory port map: agentId → { containerPort: hostPort }
const _portCache = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

function containerName(agentId) {
  return `hive-sandbox-${agentId}`;
}

function sandboxDir(agentId) {
  const dir = path.join(HIVE_DIR, 'agents', agentId, 'sandbox');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isDockerAvailable() {
  try { execSync('docker info', { stdio: 'ignore' }); return true; }
  catch { return false; }
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
  if (!isDockerAvailable()) throw new Error('Docker is not available or not running');
  const name   = containerName(agentId);
  const dir    = sandboxDir(agentId);
  const status = containerStatus(agentId);

  if (status === 'running') return dir;

  if (status === 'exited' || status === 'created') {
    execSync(`docker start ${name}`, { stdio: 'ignore' });
    delete _portCache[agentId]; // re-read ports
    return dir;
  }

  // Create a fresh container
  const image   = resolveImage();
  const portArgs = PUBLISHED_PORTS.map(p => `-p 0:${p}`).join(' ');
  execSync([
    'docker run -d',
    `--name ${name}`,
    `--label hive-sandbox=true`,
    `--label hive-agent-id=${agentId}`,
    `-v "${dir}:/workspace"`,
    `-w /workspace`,
    portArgs,
    `--memory=512m`,
    `--cpus=1.0`,
    `--network=bridge`,
    `--pids-limit=200`,
    image,
  ].join(' '), { stdio: 'ignore' });

  delete _portCache[agentId];
  return dir;
}

// ── Command execution ─────────────────────────────────────────────────────────

async function exec(agentId, cmd, timeoutMs = EXEC_TIMEOUT) {
  await ensureContainer(agentId);
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const proc  = spawn('docker', ['exec', containerName(agentId), 'bash', '-c', cmd]);
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr: stderr + '\n[timed out after 60s]', exitCode: 124 });
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? 0 }); });
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
  if (!isDockerAvailable()) return { docker: false, status: 'docker-unavailable' };
  const status = containerStatus(agentId);
  const ports  = status === 'running' ? loadPortMap(agentId) : {};
  return { docker: true, status, ports };
}

async function reset(agentId) {
  try { execSync(`docker rm -f ${containerName(agentId)}`, { stdio: 'ignore' }); } catch {}
  delete _portCache[agentId];
  const dir = path.join(HIVE_DIR, 'agents', agentId, 'sandbox');
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
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
  sandboxDir, hostPort, loadPortMap,
  isDockerAvailable, containerName,
  warmImage,
};
