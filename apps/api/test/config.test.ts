import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

const required = { GITHUB_WEBHOOK_SECRET: 'test-webhook-secret-0123456789' };

describe('loadConfig', () => {
  it('applies defaults and uses PGlite when DATABASE_URL is unset', () => {
    expect(loadConfig(required)).toEqual({
      nodeEnv: 'development',
      server: { host: '127.0.0.1', port: 3000 },
      logLevel: 'info',
      database: { driver: 'pglite', dataDir: '.data/pglite' },
      github: { webhookSecret: required.GITHUB_WEBHOOK_SECRET },
    });
  });

  it('uses Postgres when DATABASE_URL is set', () => {
    const config = loadConfig({
      ...required,
      DATABASE_URL: 'postgres://app:secret@db.internal:5432/triage',
    });
    expect(config.database).toEqual({
      driver: 'postgres',
      url: 'postgres://app:secret@db.internal:5432/triage',
    });
  });

  it('treats empty values as unset', () => {
    const config = loadConfig({ ...required, DATABASE_URL: '', PORT: '' });
    expect(config.database.driver).toBe('pglite');
    expect(config.server.port).toBe(3000);
  });

  it('requires a webhook secret of reasonable length', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ GITHUB_WEBHOOK_SECRET: 'short' })).toThrow(/GITHUB_WEBHOOK_SECRET/);
  });

  it('rejects a non-Postgres DATABASE_URL', () => {
    const env = { ...required, DATABASE_URL: 'mysql://localhost/triage' };
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => loadConfig({ ...required, PORT: '70000' })).toThrow(/PORT/);
  });
});
