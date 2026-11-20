/**
 * The real-call guard. Evals against a real model cost money and send the fixtures to a provider,
 * so they only run on an explicit opt-in, and never from tests or CI:
 *
 * - `anthropic` needs `EVAL_REAL_CALLS=1` and `ANTHROPIC_API_KEY`. Requiring the key (rather than
 *   letting the SDK find an `ant auth login` profile or another credential) means the run uses
 *   the key you put in the environment for it, and nothing else.
 * - `bedrock` would use whatever AWS credentials the shell has (profile, SSO session, instance
 *   role), so it is refused unless `EVAL_REAL_CALLS=1` is set too.
 * - `fake`, `oracle`, and `null` run locally and need nothing.
 */
export const LOCAL_EVAL_PROVIDERS = ['fake', 'oracle', 'null'] as const;
export const REAL_EVAL_PROVIDERS = ['anthropic', 'bedrock'] as const;
export const EVAL_PROVIDERS = [...LOCAL_EVAL_PROVIDERS, ...REAL_EVAL_PROVIDERS] as const;
export type EvalProvider = (typeof EVAL_PROVIDERS)[number];

export type GuardResult = { allowed: true } | { allowed: false; reason: string };

export function isEvalProvider(value: string): value is EvalProvider {
  return (EVAL_PROVIDERS as readonly string[]).includes(value);
}

export function checkRealCalls(
  provider: EvalProvider,
  env: Readonly<Record<string, string | undefined>>,
): GuardResult {
  if ((LOCAL_EVAL_PROVIDERS as readonly string[]).includes(provider)) {
    return { allowed: true };
  }
  if (env.VITEST || env.CI) {
    return {
      allowed: false,
      reason: `Refusing to call ${provider} from tests or CI. Use --provider fake, oracle, or null.`,
    };
  }
  if (env.EVAL_REAL_CALLS !== '1') {
    return {
      allowed: false,
      reason:
        `--provider ${provider} makes real, billed model calls. ` +
        `Set EVAL_REAL_CALLS=1 to allow them${provider === 'anthropic' ? ', with ANTHROPIC_API_KEY set' : ''}.`,
    };
  }
  if (provider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    return {
      allowed: false,
      reason: '--provider anthropic needs ANTHROPIC_API_KEY set (EVAL_REAL_CALLS=1 is not enough).',
    };
  }
  return { allowed: true };
}
