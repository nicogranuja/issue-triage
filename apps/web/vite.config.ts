import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// Where the API listens in development. The e2e test runs its own API on another port.
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Resolve workspace packages to their TypeScript sources (see packages/shared/package.json).
    conditions: ['@issue-triage/source', ...defaultClientConditions],
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    // The API runs separately in development (`npm run dev` starts both).
    proxy: {
      '/api': apiUrl,
      '/healthz': apiUrl,
    },
  },
});
