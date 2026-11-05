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
  },
});
