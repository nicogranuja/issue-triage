import { defineConfig, devices } from '@playwright/test';

/*
 * End-to-end tests against the real API (fake model, embedded in-memory database, demo data,
 * dry-run write-back: nothing leaves the machine) and the Vite dev server. Ports differ from
 * `npm run dev`'s, so both can run at once.
 *
 * Locally this uses the installed Google Chrome; CI installs Playwright's Chromium.
 */
const API_PORT = 3199;
const WEB_PORT = 5199;
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    ...(ci ? {} : { channel: 'chrome' }),
    viewport: { width: 1360, height: 860 },
  },
  projects: [
    { name: 'e2e', testMatch: 'review.spec.ts' },
    // `npm run screenshots`: the README images, written to docs/.
    { name: 'screenshots', testMatch: 'screenshots.spec.ts' },
  ],
  webServer: [
    {
      command: 'npx tsx --conditions=@issue-triage/source src/dev.ts',
      cwd: '../api',
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        DATABASE_URL: '',
        PGLITE_DATA_DIR: 'memory://',
        SEED_DEMO_DATA: 'true',
        TRIAGE_PROVIDER: 'fake',
        WRITE_BACK_MODE: 'dry-run',
        WRITE_BACK_DELAY_MS: '1000',
        GITHUB_TOKEN: '',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: 'npx vite',
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_URL: `http://127.0.0.1:${API_PORT}`, WEB_PORT: String(WEB_PORT) },
    },
  ],
});
