import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Resolve workspace packages to their TypeScript sources (see packages/shared/package.json).
    conditions: ['@issue-triage/source', ...defaultClientConditions],
  },
  server: {
    port: 5173,
    proxy: {
      // The API runs separately in development (`npm run dev:api`).
      '/healthz': 'http://127.0.0.1:3000',
    },
  },
});
