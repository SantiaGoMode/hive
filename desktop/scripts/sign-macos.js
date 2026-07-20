const { execFile } = require('node:child_process');
const { mkdtemp, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const { signAsync } = require('@electron/osx-sign');
const osxSignUtil = require('@electron/osx-sign/dist/cjs/util');

const execFileAsync = promisify(execFile);

async function pathIsDirectory(targetPath) {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function stripSigningDetritus(targetPath) {
  const xattrArgs = (await pathIsDirectory(targetPath)) ? ['-cr', targetPath] : ['-c', targetPath];
  await execFileAsync('/usr/bin/xattr', xattrArgs);

  if (await pathIsDirectory(targetPath)) {
    try {
      await execFileAsync('/usr/sbin/dot_clean', ['-mn', targetPath]);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

async function verifyStrictSignature(appPath) {
  await execFileAsync('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ]);
}

function findContainingCodeBundle(targetPath, appPath) {
  const topAppPath = path.resolve(appPath);
  let cursor = path.resolve(targetPath);

  while (cursor.startsWith(topAppPath) && cursor !== topAppPath) {
    const name = path.basename(cursor);
    if (name.endsWith('.app') || name.endsWith('.framework')) {
      return cursor;
    }
    cursor = path.dirname(cursor);
  }

  return null;
}

async function signWithTargetStripping(configuration) {
  const originalExecFileAsync = osxSignUtil.execFileAsync;
  let loggedCodesignIntercept = false;
  const strippedBundles = new Set();
  osxSignUtil.execFileAsync = async (file, args, options) => {
    if (file === 'codesign' && Array.isArray(args) && args.length > 0) {
      const targetPath = args[args.length - 1];
      if (typeof targetPath === 'string' && configuration.app && targetPath.startsWith(configuration.app)) {
        if (!loggedCodesignIntercept) {
          console.log(`stripping macOS signing target before codesign: ${targetPath}`);
          loggedCodesignIntercept = true;
        }
        const bundlePath = findContainingCodeBundle(targetPath, configuration.app);
        if (bundlePath && !strippedBundles.has(bundlePath)) {
          await stripSigningDetritus(bundlePath);
          strippedBundles.add(bundlePath);
        }
        const macosExecutableDir = path.join(configuration.app, 'Contents', 'MacOS');
        if (!bundlePath && targetPath.startsWith(macosExecutableDir)) {
          await stripSigningDetritus(configuration.app);
        }
        await stripSigningDetritus(targetPath);
      }
    }
    return originalExecFileAsync(file, args, options);
  };

  try {
    return await signAsync(configuration);
  } finally {
    osxSignUtil.execFileAsync = originalExecFileAsync;
  }
}

module.exports = async function signMacosApp(configuration) {
  if (!configuration || !configuration.app) {
    return signAsync(configuration);
  }

  const originalApp = configuration.app;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'hive-sign-'));
  const tempApp = path.join(tempRoot, path.basename(originalApp));

  try {
    await execFileAsync('/usr/bin/ditto', [originalApp, tempApp]);
    await stripSigningDetritus(tempApp);
    console.log(`signing temporary macOS app bundle at ${tempApp}`);

    await signWithTargetStripping({ ...configuration, app: tempApp });
    await verifyStrictSignature(tempApp);

    await rm(originalApp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await execFileAsync('/usr/bin/ditto', ['--noextattr', '--noqtn', tempApp, originalApp]);
    await stripSigningDetritus(originalApp);
    // A valid temporary signature is not enough: copying a bundle through a
    // File Provider-backed workspace can attach Finder metadata or otherwise
    // disturb the code seal. Fail the build before notarization unless the
    // exact path electron-builder will package still verifies strictly.
    await verifyStrictSignature(originalApp);
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};
