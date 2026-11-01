import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    resolve: {
      // Resolve workspace packages to their TypeScript sources (see packages/shared/package.json).
      conditions: ['@issue-triage/source', ...defaultServerConditions],
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
