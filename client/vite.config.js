import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
