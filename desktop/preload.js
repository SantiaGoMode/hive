// Exposes the Hive auth token to the renderer so the UI never shows the
// paste-a-token prompt in the desktop app. The token arrives via an
// additionalArguments flag set in main.js at window creation.
const { contextBridge } = require('electron');

const flag = '--hive-auth-token=';
const arg = process.argv.find((a) => a.startsWith(flag)) || flag;

contextBridge.exposeInMainWorld('hiveDesktop', {
  authToken: arg.slice(flag.length),
});
