import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults and uses PGlite when DATABASE_URL is unset', () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: 'development',
      server: { host: '127.0.0.1', port: 3000 },
      logLevel: 'info',
      database: { driver: 'pglite', dataDir: '.data/pglite' },
    });
  });

  it('uses Postgres when DATABASE_URL is set', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://app:secret@db.internal:5432/triage' });
    expect(config.database).toEqual({
      driver: 'postgres',
      url: 'postgres://app:secret@db.internal:5432/triage',
    });
  });

  it('treats empty values as unset', () => {
    const config = loadConfig({ DATABASE_URL: '', PORT: '' });
    expect(config.database.driver).toBe('pglite');
    expect(config.server.port).toBe(3000);
  });

  it('rejects a non-Postgres DATABASE_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost/triage' })).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost/triage' })).toThrow(/DATABASE_URL/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });
});
