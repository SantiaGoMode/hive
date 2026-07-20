#!/usr/bin/env node
// Build outside File Provider-backed workspaces (for example ~/Documents).
// macOS may otherwise attach FinderInfo/provenance metadata after signing and
// before electron-builder creates the DMG, invalidating the distributed seal.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyMacosArtifacts } = require('./verify-macos-artifacts');

const desktopDir = path.resolve(__dirname, '..');
const finalOutput = path.join(desktopDir, 'dist');
const tempOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-desktop-dist-'));
const isDevelopment = process.argv.includes('--development');
const publish = process.argv.includes('--publish') ? 'always' : 'never';
const executable = path.join(
  desktopDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);

const args = [
  `--publish=${publish}`,
  `--config.directories.output=${tempOutput}`,
];
if (isDevelopment && process.platform === 'darwin') {
  args.push(
    '--config.mac.identity=-',
    '--config.mac.hardenedRuntime=false',
    '--config.mac.notarize=false',
  );
}

let succeeded = false;
try {
  const result = spawnSync(executable, args, {
    cwd: desktopDir,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
  else {
    if (process.platform === 'darwin') {
      verifyMacosArtifacts(tempOutput, { requireNotarization: !isDevelopment });
    }

    fs.mkdirSync(finalOutput, { recursive: true });
    const artifactPattern = /\.(?:dmg|zip|AppImage|deb|exe|blockmap|ya?ml)$/;
    const artifacts = fs.readdirSync(tempOutput).filter(name =>
      artifactPattern.test(name) && !name.startsWith('builder-'));
    if (artifacts.length === 0) throw new Error(`No release artifacts produced in ${tempOutput}`);
    for (const name of artifacts) {
      fs.copyFileSync(path.join(tempOutput, name), path.join(finalOutput, name));
    }
    console.log(`copied ${artifacts.length} verified artifact(s) to ${finalOutput}`);
    succeeded = true;
  }
} finally {
  if (succeeded) fs.rmSync(tempOutput, { recursive: true, force: true });
  else console.error(`desktop build output preserved for diagnosis: ${tempOutput}`);
}
