const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

module.exports = async function verifyMacosSignature(context) {
  if (process.platform !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  await execFileAsync('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ]);

  // MacPackager completes notarization before emitting afterSign. Development
  // builds explicitly disable notarization, so only require a ticket for the
  // production path.
  if (context.packager.platformSpecificBuildOptions.notarize !== false) {
    await execFileAsync('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  }
};
