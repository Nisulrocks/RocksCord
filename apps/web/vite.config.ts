import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * In development the client runs on :5173 and the API on :4000, so both `/api` and the
 * Socket.IO endpoint are proxied. That keeps the browser on a single origin, which means
 * the refresh-token cookie behaves in development exactly as it does in production
 * (where the API serves the built client from the same origin).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(here, 'src') },
  },
  server: {
    port: 5173,
    // Bind to all interfaces so another device on the LAN can open the dev client.
    host: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/uploads': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/socket.io': { target: 'http://127.0.0.1:4000', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Split the vendor bundle so an app-code change does not invalidate React or the
    // realtime client in the browser cache. Rollup wants a function here, not a map.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // Vite normalises module ids to forward slashes, including on Windows, so a
          // plain substring test is both correct and easier to read than a path regex.
          const path = id.replace(/\\/g, '/');
          if (
            path.includes('/node_modules/react/') ||
            path.includes('/node_modules/react-dom/') ||
            path.includes('/node_modules/react-router/') ||
            path.includes('/node_modules/react-router-dom/')
          ) {
            return 'react';
          }
          if (
            path.includes('/node_modules/socket.io-client/') ||
            path.includes('/node_modules/engine.io-client/')
          ) {
            return 'realtime';
          }
          return undefined;
        },
      },
    },
  },
});
