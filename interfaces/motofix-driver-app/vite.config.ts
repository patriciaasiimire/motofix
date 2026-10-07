import { defineConfig, createLogger } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// Vite adds its own error listener after configure() runs, so configure() can't
// suppress it. A custom logger is the only reliable place to filter it out.
const logger = createLogger();
const _err = logger.error.bind(logger);
logger.error = (msg, opts) => {
  if (opts?.error?.code === 'ECONNRESET') return;
  if (msg.includes('ECONNRESET')) return;
  _err(msg, opts);
};
// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  customLogger: logger,
  server: {
    host: "127.0.0.1",
    port: 8085,
    allowedHosts: 'all',
    proxy: {
      '/auth':         { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/users':        { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/requests': {
        target: 'http://127.0.0.1:8001', changeOrigin: true,
        bypass: (req) => {
          // Browser page navigations (Accept: text/html) should be handled by
          // the SPA, not proxied to the API — prevents raw JSON on hard refresh.
          if (req.headers?.accept?.includes('text/html')) return '/index.html';
        },
      },
      '/ws': {
        target: 'http://127.0.0.1:8001', changeOrigin: true, ws: true,
        configure: (proxy) => {
          proxy.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ECONNRESET') return // browser closed the tab/refreshed — harmless
            console.error('[ws proxy]', err.message)
          })
        },
      },
      '/feature-flags':{ target: 'http://127.0.0.1:8001', changeOrigin: true },
      '/payments':     { target: 'http://127.0.0.1:8001', changeOrigin: true },
      '/match':        { target: 'http://127.0.0.1:8003', changeOrigin: true },
      '/chat':         { target: 'http://127.0.0.1:8007', changeOrigin: true },
      '/diagnose':     { target: 'http://127.0.0.1:8007', changeOrigin: true },
      '/parts-price':  { target: 'http://127.0.0.1:8007', changeOrigin: true },
      '/parts-dealers':{ target: 'http://127.0.0.1:8007', changeOrigin: true },
      '/fuel-advisor': { target: 'http://127.0.0.1:8007', changeOrigin: true },
      '/claims':       { target: 'http://127.0.0.1:8006', changeOrigin: true },
      '/insurers':     { target: 'http://127.0.0.1:8006', changeOrigin: true },
      '/applications': { target: 'http://127.0.0.1:8006', changeOrigin: true },
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
