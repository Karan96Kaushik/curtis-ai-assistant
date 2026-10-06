import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  server: {
    port: 5173,
  },
  // The repo root also holds the Firefox extension's HTML pages; only crawl the SPA.
  optimizeDeps: {
    entries: ['index.html'],
  },
});
