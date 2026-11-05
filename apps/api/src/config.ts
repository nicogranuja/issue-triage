import { z } from 'zod';

import {
  TRIAGE_EFFORTS,
  TRIAGE_PROVIDERS,
  type TriageEffort,
  type TriageProvider,
} from './triage/model.js';

const databaseEnvSchema = z.object({
  /** When set, connect to this Postgres server. When unset, use an embedded PGlite database. */
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' })
    .optional(),
  /** Where PGlite keeps its files. `memory://` keeps everything in memory. */
  PGLITE_DATA_DIR: z.string().min(1).default('.data/pglite'),
});

/**
 * What the triage worker needs. Provider credentials are deliberately absent: the Anthropic SDK
 * reads `ANTHROPIC_API_KEY` itself, and the Bedrock client uses the standard AWS credential
 * chain, so secrets never pass through this object (or anything that might log it).
 */
const processEnvSchema = databaseEnvSchema
  .extend({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Read access to repository labels. Optional: public repositories work without it. */
    GITHUB_TOKEN: z.string().min(1).optional(),
    TRIAGE_PROVIDER: z.enum(TRIAGE_PROVIDERS),
    /** Overrides the provider's default model id. */
    TRIAGE_MODEL: z.string().min(1).optional(),
    TRIAGE_EFFORT: z.enum(TRIAGE_EFFORTS).default('medium'),
    /** Per request to the model; the SDK retries timeouts, within the job's overall deadline. */
    TRIAGE_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
    /** Concurrent jobs in this process. 0 runs no worker here (for example, API-only servers). */
    TRIAGE_WORKER_CONCURRENCY: z.coerce.number().int().min(0).max(32).default(1),
    TRIAGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    AWS_REGION: z.string().min(1).optional(),
    AWS_DEFAULT_REGION: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.TRIAGE_PROVIDER === 'bedrock' && !(env.AWS_REGION ?? env.AWS_DEFAULT_REGION)) {
      ctx.addIssue({
        code: 'custom',
        path: ['AWS_REGION'],
        message: 'is required when TRIAGE_PROVIDER=bedrock',
      });
    }
    if (env.TRIAGE_PROVIDER === 'fake' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['TRIAGE_PROVIDER'],
        message: 'fake is for tests and local development, not production',
      });
    }
  });

const serverEnvSchema = processEnvSchema.safeExtend({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  /** Shared secret configured on the GitHub webhook; used to verify `X-Hub-Signature-256`. */
  GITHUB_WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 characters'),
});

/** Default model per provider. Bedrock ids carry an `anthropic.` prefix. */
export const DEFAULT_TRIAGE_MODELS: Record<TriageProvider, string> = {
  anthropic: 'claude-opus-5-5',
  bedrock: 'anthropic.claude-opus-5-5',
  fake: 'fake-triage-model',
};

export type DatabaseConfig =
  { driver: 'postgres'; url: string } | { driver: 'pglite'; dataDir: string };

export interface TriageConfig {
  provider: TriageProvider;
  model: string;
  effort: TriageEffort;
  modelTimeoutMs: number;
  /** Set when the provider is Bedrock. */
  awsRegion?: string;
}

export interface WorkerConfig {
  /** Jobs run concurrently by this process; 0 means no worker. */
  concurrency: number;
  maxAttempts: number;
}

/** Configuration for a process that runs triage jobs: the worker, or the API with a worker. */
export interface ProcessConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: z.infer<typeof processEnvSchema>['LOG_LEVEL'];
  database: DatabaseConfig;
  triage: TriageConfig;
  worker: WorkerConfig;
  github: { token?: string };
}

/** Validated runtime configuration of the API server. Built once at startup, passed down. */
export interface Config extends ProcessConfig {
  server: { host: string; port: number };
  github: { token?: string; webhookSecret: string };
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

function toProcessConfig(env: z.output<typeof processEnvSchema>): ProcessConfig {
  const awsRegion = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    database: toDatabaseConfig(env),
    triage: {
      provider: env.TRIAGE_PROVIDER,
      model: env.TRIAGE_MODEL ?? DEFAULT_TRIAGE_MODELS[env.TRIAGE_PROVIDER],
      effort: env.TRIAGE_EFFORT,
      modelTimeoutMs: env.TRIAGE_MODEL_TIMEOUT_MS,
      ...(env.TRIAGE_PROVIDER === 'bedrock' && awsRegion && { awsRegion }),
    },
    worker: { concurrency: env.TRIAGE_WORKER_CONCURRENCY, maxAttempts: env.TRIAGE_MAX_ATTEMPTS },
    github: env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {},
  };
}

/** Loads only what the database tooling (migrations) needs. */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return toDatabaseConfig(parseEnv(databaseEnvSchema, env));
}

/** Loads the configuration of the standalone worker process. */
export function loadProcessConfig(env: NodeJS.ProcessEnv = process.env): ProcessConfig {
  return toProcessConfig(parseEnv(processEnvSchema, env));
}

/** Loads the configuration of the API server. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = parseEnv(serverEnvSchema, env);
  const base = toProcessConfig(parsed);
  return {
    ...base,
    server: { host: parsed.HOST, port: parsed.PORT },
    github: { ...base.github, webhookSecret: parsed.GITHUB_WEBHOOK_SECRET },
  };
}
