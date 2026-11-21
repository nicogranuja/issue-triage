/**
 * The real-call guard. Evals against a real model cost money and send the fixtures to a provider,
 * so they only run on an explicit opt-in, and never from tests or CI:
 *
 * - `anthropic` needs `EVAL_REAL_CALLS=1` and `ANTHROPIC_API_KEY`. Requiring the key (rather than
 *   letting the SDK find an `ant auth login` profile or another credential) means the run uses
 *   the key you put in the environment for it, and nothing else.
 * - `bedrock` would use whatever AWS credentials the shell has (profile, SSO session, instance
 *   role, `AWS_BEARER_TOKEN_BEDROCK`), so it also needs its own opt-in, `EVAL_ALLOW_BEDROCK=1`.
 * - Real calls are refused from an AI coding agent's session (`CLAUDECODE` is set): an agent's
 *   shell inherits your credentials, so a real, billed run has to be started by you, in your own
 *   terminal.
 * - `fake`, `oracle`, and `null` run locally and need nothing.
 *
 * The summary judge (`--judge`) goes through the same gate: `--judge anthropic` is a real, billed
 * call to the Anthropic API whatever the provider under test is, so it needs the same opt-in and
 * key, and is refused in the same places. `--judge fake` is a local keyword rule.
 */
export const LOCAL_EVAL_PROVIDERS = ['fake', 'oracle', 'null'] as const;
export const REAL_EVAL_PROVIDERS = ['anthropic', 'bedrock'] as const;
export const EVAL_PROVIDERS = [...LOCAL_EVAL_PROVIDERS, ...REAL_EVAL_PROVIDERS] as const;
export type EvalProvider = (typeof EVAL_PROVIDERS)[number];

export type GuardResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Why a real call must not start in this environment at all, whatever the opt-ins say: from tests,
 * from CI, or from an AI coding agent's session. `null` when none applies.
 */
export function blockedEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (env.VITEST || env.CI) {
    return 'tests or CI';
  }
  if (env.CLAUDECODE) {
    return 'an AI coding agent session (CLAUDECODE is set), which inherits your shell credentials';
  }
  return null;
}

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
  const blocked = blockedEnvironment(env);
  if (blocked) {
    return {
      allowed: false,
      reason:
        `Refusing to call ${provider} from ${blocked}. Use --provider fake, oracle, or null, ` +
        'or start the real run yourself in your own terminal.',
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
  if (provider === 'bedrock' && env.EVAL_ALLOW_BEDROCK !== '1') {
    return {
      allowed: false,
      reason:
        '--provider bedrock uses whatever AWS credentials the shell has, so it also needs ' +
        'EVAL_ALLOW_BEDROCK=1 (EVAL_REAL_CALLS=1 is not enough).',
    };
  }
  return { allowed: true };
}

export const JUDGE_KINDS = ['fake', 'anthropic'] as const;
export type JudgeKind = (typeof JUDGE_KINDS)[number];

export function isJudgeKind(value: string): value is JudgeKind {
  return (JUDGE_KINDS as readonly string[]).includes(value);
}

/** The real-call guard for the summary judge: the same rules as `--provider anthropic`. */
export function checkRealJudge(
  kind: JudgeKind,
  env: Readonly<Record<string, string | undefined>>,
): GuardResult {
  if (kind === 'fake') {
    return { allowed: true };
  }
  const blocked = blockedEnvironment(env);
  if (blocked) {
    return {
      allowed: false,
      reason:
        `Refusing to run the ${kind} judge from ${blocked}. Use --judge fake, or start the ` +
        'real run yourself in your own terminal.',
    };
  }
  if (env.EVAL_REAL_CALLS !== '1') {
    return {
      allowed: false,
      reason:
        `--judge ${kind} makes real, billed model calls. Set EVAL_REAL_CALLS=1 to allow them, ` +
        'with ANTHROPIC_API_KEY set.',
    };
  }
  if (!env.ANTHROPIC_API_KEY) {
    return {
      allowed: false,
      reason: `--judge ${kind} needs ANTHROPIC_API_KEY set (EVAL_REAL_CALLS=1 is not enough).`,
    };
  }
  return { allowed: true };
}
