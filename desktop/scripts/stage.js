// Stage the server + production node_modules + client build for packaging.
// Keeps the repo's node_modules untouched (dev stays on Node ABI): production
// deps are installed fresh into desktop/staging and better-sqlite3 is rebuilt
// there against Electron's ABI (utilityProcess loads native modules with the
// Electron ABI, not the system Node one).
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const repo = path.join(__dirname, '..', '..');
const desktop = path.join(__dirname, '..');
const staging = path.join(desktop, 'staging');

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  // npm/npx are .cmd shims on Windows and need a shell to spawn.
  execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

// Keep the desktop version in lockstep with the root package.json (the single
// source of truth for release tags).
const desktopPkgPath = path.join(desktop, 'package.json');
const desktopPkg = JSON.parse(fs.readFileSync(desktopPkgPath, 'utf8'));
if (desktopPkg.version !== rootPkg.version) {
  desktopPkg.version = rootPkg.version;
  fs.writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, 2) + '\n');
  console.log(`synced desktop version -> ${rootPkg.version}`);
}

const clientDist = path.join(repo, 'client', 'dist');
if (!fs.existsSync(path.join(clientDist, 'index.html'))) {
  console.error('client/dist is missing — run "npm run build" at the repo root first.');
  process.exit(1);
}

console.log('staging ->', staging);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

// Server source (no tests) + manifests + client build.
fs.cpSync(path.join(repo, 'server'), path.join(staging, 'server'), {
  recursive: true,
  filter: (src) => !src.includes(`${path.sep}server${path.sep}tests`),
});
fs.copyFileSync(path.join(repo, 'package.json'), path.join(staging, 'package.json'));
fs.copyFileSync(path.join(repo, 'package-lock.json'), path.join(staging, 'package-lock.json'));
fs.cpSync(clientDist, path.join(staging, 'client', 'dist'), { recursive: true });
// Gateway alias config — read (optionally) at startup to list gateway models.
fs.mkdirSync(path.join(staging, 'gateway'), { recursive: true });
fs.copyFileSync(path.join(repo, 'gateway', 'litellm.config.yaml'), path.join(staging, 'gateway', 'litellm.config.yaml'));

// Production dependencies, then rebuild the non-N-API native module for
// Electron. @ngrok/ngrok is N-API (ABI-stable) and keeps its prebuilds.
run('npm', ['ci', '--omit=dev'], { cwd: staging });

const electronVersion = JSON.parse(
  fs.readFileSync(path.join(desktop, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;
run('npx', ['@electron/rebuild', '--version', electronVersion, '--module-dir', staging, '--only', 'better-sqlite3'], {
  cwd: desktop,
});

console.log('staging complete');
