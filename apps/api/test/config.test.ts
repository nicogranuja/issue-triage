import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, loadProcessConfig } from '../src/config.js';

const required = {
  GITHUB_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
  TRIAGE_PROVIDER: 'anthropic',
};

describe('loadConfig', () => {
  it('applies defaults and uses PGlite when DATABASE_URL is unset', () => {
    expect(loadConfig(required)).toEqual({
      nodeEnv: 'development',
      server: { host: '127.0.0.1', port: 3000 },
      logLevel: 'info',
      database: { driver: 'pglite', dataDir: '.data/pglite' },
      github: { webhookSecret: required.GITHUB_WEBHOOK_SECRET },
      triage: {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        effort: 'medium',
        modelTimeoutMs: 60_000,
      },
      worker: { concurrency: 1, maxAttempts: 5 },
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
    const config = loadConfig({ ...required, DATABASE_URL: '', PORT: '', TRIAGE_MODEL: '' });
    expect(config.database.driver).toBe('pglite');
    expect(config.server.port).toBe(3000);
    expect(config.triage.model).toBe('claude-opus-5-5');
  });

  it('requires a webhook secret of reasonable length', () => {
    expect(() => loadConfig({ TRIAGE_PROVIDER: 'fake' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...required, GITHUB_WEBHOOK_SECRET: 'short' })).toThrow(
      /GITHUB_WEBHOOK_SECRET/,
    );
  });

  it('rejects a non-Postgres DATABASE_URL', () => {
    const env = { ...required, DATABASE_URL: 'mysql://localhost/triage' };
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => loadConfig({ ...required, PORT: '70000' })).toThrow(/PORT/);
  });

  it('passes the GitHub token through when set', () => {
    expect(loadConfig({ ...required, GITHUB_TOKEN: 'ghp_example' }).github).toEqual({
      token: 'ghp_example',
      webhookSecret: required.GITHUB_WEBHOOK_SECRET,
    });
  });
});

describe('triage configuration', () => {
  const load = (env: Record<string, string>) => loadProcessConfig(env).triage;

  it('requires a known provider', () => {
    expect(() => loadProcessConfig({})).toThrow(/TRIAGE_PROVIDER/);
    expect(() => load({ TRIAGE_PROVIDER: 'openai' })).toThrow(/TRIAGE_PROVIDER/);
  });

  it('defaults each provider to its current model id', () => {
    expect(load({ TRIAGE_PROVIDER: 'anthropic' }).model).toBe('claude-opus-5-5');
    expect(load({ TRIAGE_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1' }).model).toBe(
      'anthropic.claude-opus-5-5',
    );
    expect(load({ TRIAGE_PROVIDER: 'fake' }).model).toBe('fake-triage-model');
  });

  it('accepts a model override and an effort level', () => {
    expect(
      load({
        TRIAGE_PROVIDER: 'anthropic',
        TRIAGE_MODEL: 'claude-sonnet-5-5',
        TRIAGE_EFFORT: 'low',
      }),
    ).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
    expect(() => load({ TRIAGE_PROVIDER: 'anthropic', TRIAGE_EFFORT: 'extreme' })).toThrow(
      /TRIAGE_EFFORT/,
    );
  });

  it('requires a region for Bedrock, from AWS_REGION or AWS_DEFAULT_REGION', () => {
    expect(() => load({ TRIAGE_PROVIDER: 'bedrock' })).toThrow(/AWS_REGION/);
    expect(load({ TRIAGE_PROVIDER: 'bedrock', AWS_DEFAULT_REGION: 'eu-west-1' }).awsRegion).toBe(
      'eu-west-1',
    );
  });

  it('refuses the fake provider in production', () => {
    expect(() => load({ TRIAGE_PROVIDER: 'fake', NODE_ENV: 'production' })).toThrow(
      /fake is for tests/,
    );
  });

  it('bounds the model timeout and worker settings', () => {
    const base = { TRIAGE_PROVIDER: 'fake' };
    expect(() => load({ ...base, TRIAGE_MODEL_TIMEOUT_MS: '10' })).toThrow(/TIMEOUT/);
    expect(() => loadProcessConfig({ ...base, TRIAGE_WORKER_CONCURRENCY: '-1' })).toThrow();
    expect(() => loadProcessConfig({ ...base, TRIAGE_MAX_ATTEMPTS: '0' })).toThrow();
    expect(loadProcessConfig({ ...base, TRIAGE_WORKER_CONCURRENCY: '0' }).worker).toEqual({
      concurrency: 0,
      maxAttempts: 5,
    });
  });

  it('does not need the webhook secret for the standalone worker', () => {
    expect(loadProcessConfig({ TRIAGE_PROVIDER: 'fake' }).github).toEqual({});
  });

  it('keeps provider credentials out of the configuration', () => {
    const config = loadConfig({
      ...required,
      ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key',
      AWS_SECRET_ACCESS_KEY: 'not-a-real-secret',
    });
    expect(JSON.stringify(config)).not.toMatch(/not-a-real/);
  });
});
