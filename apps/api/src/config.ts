import { z } from 'zod';

const databaseEnvSchema = z.object({
  /** When set, connect to this Postgres server. When unset, use an embedded PGlite database. */
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' })
    .optional(),
  /** Where PGlite keeps its files. `memory://` keeps everything in memory. */
  PGLITE_DATA_DIR: z.string().min(1).default('.data/pglite'),
});

const envSchema = databaseEnvSchema.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Shared secret configured on the GitHub webhook; used to verify `X-Hub-Signature-256`. */
  GITHUB_WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 characters'),
});

export type DatabaseConfig =
  { driver: 'postgres'; url: string } | { driver: 'pglite'; dataDir: string };

/** Validated runtime configuration. Built once at startup and passed down explicitly. */
export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  server: { host: string; port: number };
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  database: DatabaseConfig;
  github: { webhookSecret: string };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Validates environment variables against a schema. Empty values count as unset, so a blank
 * `KEY=` line in `.env` falls back to the default instead of failing validation.
 */
function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.output<T> {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = schema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function toDatabaseConfig(env: z.output<typeof databaseEnvSchema>): DatabaseConfig {
  return env.DATABASE_URL
    ? { driver: 'postgres', url: env.DATABASE_URL }
    : { driver: 'pglite', dataDir: env.PGLITE_DATA_DIR };
}

/** Loads only what the database tooling (migrations) needs. */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return toDatabaseConfig(parseEnv(databaseEnvSchema, env));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = parseEnv(envSchema, env);
  return {
    nodeEnv: parsed.NODE_ENV,
    server: { host: parsed.HOST, port: parsed.PORT },
    logLevel: parsed.LOG_LEVEL,
    database: toDatabaseConfig(parsed),
    github: { webhookSecret: parsed.GITHUB_WEBHOOK_SECRET },
  };
}
