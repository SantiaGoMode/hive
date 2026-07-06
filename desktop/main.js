// Hive desktop shell. Boots the existing Express server as a child process,
// waits for /healthz, then opens a BrowserWindow at the local origin with the
// auth token injected via preload — same server, same ~/.hive data as the
// browser/dev workflows.
const { app, BrowserWindow, Menu, utilityProcess, shell, dialog } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');

const HIVE_HOME = process.env.HIVE_HOME || path.join(os.homedir(), '.hive');
const LOG_PATH = path.join(HIVE_HOME, 'desktop.log');
const MAX_RESTARTS = 3;

let serverProc = null;
let mainWindow = null;
let serverPort = null;
let quitting = false;
let restarts = 0;
let logStream = null;

function log(line) {
  try {
    if (!logStream) {
      fs.mkdirSync(HIVE_HOME, { recursive: true, mode: 0o700 });
      logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    }
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch { /* logging must never take the app down */ }
}

// GUI apps launched from Finder/dock get launchd's minimal PATH, not the
// user's shell PATH — so docker/gh/npx/uvx in /opt/homebrew/bin etc. look
// "missing" to the server's probes and MCP/sandbox spawns fail. Resolve the
// login shell's PATH once at boot and inject it into everything we spawn.
function resolveShellPath() {
  if (process.platform === 'win32') return process.env.PATH || '';
  const marker = '__HIVE_PATH__';
  try {
    const shellBin = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const out = execFileSync(shellBin, ['-ilc', `echo ${marker}$PATH`], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'], // rc-file noise goes to stderr, marker line to stdout
    });
    const line = out.split('\n').find((l) => l.includes(marker));
    if (line) return line.slice(line.indexOf(marker) + marker.length).trim();
  } catch (e) {
    log(`login-shell PATH resolution failed: ${e.message}`);
  }
  return process.env.PATH || '';
}

// Belt and braces for shells with no rc-managed PATH: the usual CLI homes.
const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
];

function buildPath() {
  const parts = resolveShellPath().split(path.delimiter).filter(Boolean);
  for (const dir of EXTRA_PATH_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(path.delimiter);
}

// Packaged: server + production node_modules + client/dist live in
// process.resourcesPath (outside asar — the server spawns children and reads
// files like Dockerfile.sandbox by path). Dev: use the repo checkout.
function serverEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'index.js')
    : path.join(__dirname, '..', 'server', 'index.js');
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startServer(port) {
  const env = { ...process.env, PORT: String(port), HIVE_DESKTOP: '1' };
  const entry = serverEntry();
  if (app.isPackaged) {
    // utilityProcess runs on Electron's bundled Node — no system Node needed.
    // Native modules in the staged resources tree are Electron-ABI (stage.js).
    serverProc = utilityProcess.fork(entry, [], { env, stdio: 'pipe', serviceName: 'hive-server' });
  } else {
    // Dev: the repo node_modules are Node-ABI, so run with the system Node.
    serverProc = spawn('node', [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  serverProc.stdout?.on('data', (d) => log(`[server] ${String(d).trimEnd()}`));
  serverProc.stderr?.on('data', (d) => log(`[server:err] ${String(d).trimEnd()}`));
  serverProc.on('exit', (code) => {
    log(`server exited with code ${code}`);
    if (quitting) return;
    if (restarts < MAX_RESTARTS) {
      restarts += 1;
      log(`restarting server (attempt ${restarts}/${MAX_RESTARTS})`);
      setTimeout(() => startServer(port), 1_000 * restarts);
    } else {
      dialog.showErrorBox(
        'Hive server stopped',
        `The Hive server crashed repeatedly. See the log for details:\n${LOG_PATH}`,
      );
      app.quit();
    }
  });
  log(`server starting on port ${port} (${app.isPackaged ? 'packaged' : 'dev'})`);
}

function waitForHealthz(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1_000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return resolve(false);
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

// The server generates ~/.hive/auth_token on first boot (before listen), so
// after /healthz responds the file is guaranteed to exist — unless auth comes
// from the environment, in which case that value is the token.
function readAuthToken() {
  if (process.env.HIVE_AUTH_TOKEN) return process.env.HIVE_AUTH_TOKEN;
  try {
    return fs.readFileSync(path.join(HIVE_HOME, 'auth_token'), 'utf8').trim();
  } catch {
    return '';
  }
}

// v1 update story: manual check against GitHub Releases with a download link.
// electron-updater can replace this once code signing is in place.
const REPO_SLUG = 'SantiaGoMode/hive';

async function checkForUpdates() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`, {
      headers: { 'User-Agent': 'hive-desktop' },
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const latest = await res.json();
    const latestVersion = String(latest.tag_name || '').replace(/^v/, '');
    if (latestVersion && latestVersion !== app.getVersion()) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        message: `Hive ${latestVersion} is available`,
        detail: `You have ${app.getVersion()}.`,
        buttons: ['Download', 'Later'],
        defaultId: 0,
      });
      if (response === 0) shell.openExternal(latest.html_url);
    } else {
      dialog.showMessageBox({
        type: 'info',
        message: "You're up to date",
        detail: `Hive ${app.getVersion()} is the latest version.`,
      });
    }
  } catch (e) {
    dialog.showErrorBox('Update check failed', e.message);
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const updateItem = { label: 'Check for Updates…', click: checkForUpdates };
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        updateItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : [updateItem]),
        { label: 'Hive on GitHub', click: () => shell.openExternal(`https://github.com/${REPO_SLUG}`) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(port, token) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: 'Hive',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--hive-auth-token=${token}`],
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  // External links (docs, install pages) open in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function boot() {
  try {
    process.env.PATH = buildPath();
    log(`PATH resolved to: ${process.env.PATH}`);
    serverPort = Number(process.env.HIVE_DESKTOP_PORT) || await findFreePort();
    startServer(serverPort);
    const healthy = await waitForHealthz(serverPort);
    if (!healthy) {
      dialog.showErrorBox(
        'Hive failed to start',
        `The server did not become ready in time. See the log:\n${LOG_PATH}`,
      );
      app.quit();
      return;
    }
    buildMenu();
    createWindow(serverPort, readAuthToken());
  } catch (e) {
    log(`boot failed: ${e.stack || e.message}`);
    dialog.showErrorBox('Hive failed to start', String(e.message || e));
    app.quit();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('activate', () => {
    // macOS dock click with no window: reopen against the running server.
    if (!mainWindow && serverPort) createWindow(serverPort, readAuthToken());
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    quitting = true;
    try { serverProc?.kill(); } catch { /* already gone */ }
  });
}
