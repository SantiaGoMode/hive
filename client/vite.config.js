import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const reactRefreshPreamble = {
  name: 'react-refresh-preamble',
  apply: 'serve',
  transformIndexHtml() {
    return [{
      tag: 'script',
      attrs: { type: 'module' },
      injectTo: 'head-prepend',
      children: `import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;`
    }];
  }
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [reactRefreshPreamble, react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: false,
        // No timeout — required for long-running SSE streams (pipelines, schedules)
        timeout: 0,
        proxyTimeout: 0,
      },
      '/ws/chat': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
