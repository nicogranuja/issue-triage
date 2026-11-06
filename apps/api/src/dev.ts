/**
 * `npm run dev`: the API server with settings for trying the app locally. Each default applies
 * only when the variable is unset, so `.env` and the environment still win.
 *
 * - The fake model, so no API key is needed.
 * - Dry-run write-back, so reviews are never written to a real repository by accident.
 * - Demo data loaded into an empty embedded database (not into a Postgres server you point at).
 * - A placeholder webhook secret, which is fine while nothing outside this machine can reach it.
 */
import { DEMO_PRIORITY_LABELS } from './dev/seed.js';

const defaults: Record<string, string> = {
  TRIAGE_PROVIDER: 'fake',
  GITHUB_WEBHOOK_SECRET: 'local-development-only-not-a-secret',
  WRITE_BACK_MODE: 'dry-run',
  PRIORITY_LABELS: JSON.stringify(DEMO_PRIORITY_LABELS),
  ...(!process.env.DATABASE_URL && { SEED_DEMO_DATA: 'true' }),
};
for (const [name, value] of Object.entries(defaults)) {
  // An empty value counts as unset, as in the configuration loader.
  if ((process.env[name] ?? '') === '') {
    process.env[name] = value;
  }
}

await import('./index.js');
