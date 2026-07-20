#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(file, args) {
  execFileSync(file, args, { stdio: 'inherit' });
}

function attachWithRetry(dmgPath) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const plist = execFileSync('/usr/bin/hdiutil', [
        'attach', '-readonly', '-nobrowse', '-plist', dmgPath,
      ]);
      const json = execFileSync('/usr/bin/plutil', [
        '-convert', 'json', '-o', '-', '--', '-',
      ], { input: plist, encoding: 'utf8' });
      const entity = JSON.parse(json)['system-entities']
        .find(item => typeof item['mount-point'] === 'string');
      if (!entity) throw new Error(`hdiutil did not report a mount point for ${dmgPath}`);
      return entity['mount-point'];
    } catch (error) {
      lastError = error;
      if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1_000);
    }
  }
  throw lastError;
}

function verifyMacosArtifacts(outputDir, { requireNotarization = true } = {}) {
  if (process.platform !== 'darwin') return [];
  const directory = path.resolve(outputDir);
  const dmgs = fs.readdirSync(directory)
    .filter(name => name.endsWith('.dmg'))
    .sort();
  if (dmgs.length === 0) throw new Error(`No DMG artifacts found in ${directory}`);

  for (const name of dmgs) {
    const dmgPath = path.join(directory, name);
    let mountPoint = null;
    let attached = false;
    try {
      mountPoint = attachWithRetry(dmgPath);
      attached = true;
      const appPath = path.join(mountPoint, 'Hive.app');
      if (!fs.existsSync(appPath)) throw new Error(`${name} does not contain Hive.app`);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
      if (requireNotarization) {
        run('/usr/sbin/spctl', ['--assess', '--verbose=4', '--type', 'exec', appPath]);
        run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
      }
    } finally {
      if (attached) {
        try { run('/usr/bin/hdiutil', ['detach', mountPoint]); } catch { /* preserve the verification error */ }
      }
    }
    // Verify after detaching. Running `hdiutil verify` immediately before an
    // attach can leave DiskImages busy long enough for attach to fail with the
    // misleading "Device not configured" error.
    run('/usr/bin/hdiutil', ['verify', dmgPath]);
  }
  return dmgs;
}

if (require.main === module) {
  const development = process.argv.includes('--development');
  const outputDir = process.argv.slice(2).find(arg => !arg.startsWith('--'))
    || path.join(__dirname, '..', 'dist');
  verifyMacosArtifacts(outputDir, { requireNotarization: !development });
}

module.exports = { verifyMacosArtifacts };
