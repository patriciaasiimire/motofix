import { defineConfig, createLogger } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'

const logger = createLogger();
const _err = logger.error.bind(logger);
logger.error = (msg, opts) => {
  if (opts?.error?.code === 'ECONNRESET') return;
  if (msg.includes('ECONNRESET')) return;
  _err(msg, opts);
};

export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    // 8088 is the port everything (bookmarks, the iPhone cert-trust setup) already uses,
    // so `npm run dev` serves it by default — no need to pass --port each time.
    port: 8088,
    strictPort: true,
    // HTTPS disabled for local Windows dev; re-enable only with valid cert.pem and cert-key.pem.
    proxy: {
      // Use 127.0.0.1 (not "localhost"): on Windows + Docker here, "localhost"
      // resolves to IPv6 ::1 and the port-forward is flaky, so proxied API calls
      // hang until the 30s axios timeout → "Network Error / cannot reach server".
      '/auth':          { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/providers':     { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/mechanics':     { target: 'http://127.0.0.1:8002', changeOrigin: true },
      '/requests':      { target: 'http://127.0.0.1:8001', changeOrigin: true },
      // Platform-fee ledger (GET/POST /fees/...) lives in the dispatch service too. Without
      // this, /fees fell through to the SPA fallback and returned index.html, which the Fees
      // tab read as an empty balance → the bogus "Nothing to pay". Route it to dispatch.
      '/fees':          { target: 'http://127.0.0.1:8001', changeOrigin: true },
      // Diagnosis service (MOTOBOT chat, greetings, estimates) — proxied so the HTTPS dev
      // app reaches it same-origin (direct http://localhost:8007 is mixed-content + CORS blocked).
      '/chat':             { target: 'http://127.0.0.1:8007', changeOrigin: true },
      '/diagnose':         { target: 'http://127.0.0.1:8007', changeOrigin: true },
      '/greetings':        { target: 'http://127.0.0.1:8007', changeOrigin: true },
      '/service-estimate': { target: 'http://127.0.0.1:8007', changeOrigin: true },
      '/transcribe':       { target: 'http://127.0.0.1:8007', changeOrigin: true },
      '/parts-price':      { target: 'http://127.0.0.1:8007', changeOrigin: true },
      '/ws': {
        target: 'ws://127.0.0.1:8001', ws: true, changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ECONNRESET') return // browser closed the tab/refreshed — harmless
            console.error('[ws proxy]', err.message)
          })
        },
      },
      '/subscriptions': { target: 'http://127.0.0.1:8005', changeOrigin: true },
    },
  },
})
