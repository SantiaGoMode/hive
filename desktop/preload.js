// Keep the desktop bridge deliberately non-sensitive. Authentication headers
// are injected by the main process only for the local Hive origin.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('hiveDesktop', {
  isDesktop: true,
});
