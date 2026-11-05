import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    resolve: {
      // Resolve workspace packages to their TypeScript sources (see packages/shared/package.json).
      // Drop the bundler-only `module` condition: Node loads external dependencies itself, and
      // some (the AWS SDK) publish `module` builds that only a bundler can load.
      conditions: [
        '@issue-triage/source',
        ...defaultServerConditions.filter((condition) => condition !== 'module'),
      ],
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Setup hooks start an embedded PGlite (WASM) per test file, in parallel. On a busy or small
    // machine that can take longer than the 10 second default; tests keep the 5 second limit.
    hookTimeout: 30_000,
  },
});
