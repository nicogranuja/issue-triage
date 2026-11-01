import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/** Validated runtime configuration. Built once at startup and passed down explicitly. */
export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  server: { host: string; port: number };
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Parses configuration from environment variables. Empty values count as unset, so a blank
 * `KEY=` line in `.env` falls back to the default instead of failing validation.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  const parsed = result.data;
  return {
    nodeEnv: parsed.NODE_ENV,
    server: { host: parsed.HOST, port: parsed.PORT },
    logLevel: parsed.LOG_LEVEL,
  };
}
