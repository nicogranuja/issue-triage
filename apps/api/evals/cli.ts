/**
 * `npm run eval`: runs one provider over the eval fixtures and writes a report.
 *
 *   npm run eval -- --provider fake            # the keyword baseline (the default)
 *   npm run eval -- --provider oracle          # ground truth: every metric should be perfect
 *   EVAL_REAL_CALLS=1 ANTHROPIC_API_KEY=... npm run eval -- --provider anthropic --effort low
 *   npm run eval -- --judge fake               # judge the summaries (off by default)
 *   EVAL_REAL_CALLS=1 ANTHROPIC_API_KEY=... npm run eval -- --judge anthropic
 *
 * With `--judge`, the run's summaries and the hand-scored calibration set are judged, and the
 * report adds the judge's scores, its agreement with the hand scores, and its own cost. The real
 * judge (`anthropic`) is behind the same guard as a real provider.
 *
 * Output goes to `apps/api/.evals/` (gitignored): `runs/<time>-<provider>/` holds `report.md`,
 * `report.json`, `results.jsonl` (one scored outcome per case and rep), and `errors.jsonl` (the
 * infrastructure-error sidecar), and with `--judge`, `judgments.jsonl`, `calibration.jsonl`, and
 * `judge-errors.jsonl`. Real-provider outcomes are cached in `cache/` and real verdicts in
 * `judge-cache/`; the local
 * providers are free and deterministic, so they always run fresh (a cache would hide code
 * changes). The script doesn't load `.env`: real calls take variables set for the run itself.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { DEFAULT_TRIAGE_MODELS } from '../src/config.js';
import type { CreateMessage } from '../src/triage/messages-model.js';
import { FakeTriageModel } from '../src/triage/fake-model.js';
import { TRIAGE_EFFORTS, type TriageEffort, type TriageModel } from '../src/triage/model.js';
import { PROMPT_VERSION, PROMPT_VERSIONS, type PromptVersion } from '../src/triage/prompt.js';
import { createTriageModel } from '../src/triage/providers.js';
import { nullModel, oracleModel } from './baselines.js';
import { loadFixtures, type Fixture } from './cases.js';
import { calibrationItems, calibrationResult, loadCalibration } from './calibration.js';
import {
  checkRealCalls,
  isEvalProvider,
  isJudgeKind,
  JUDGE_KINDS,
  type EvalProvider,
} from './guard.js';
import {
  createSummaryJudge,
  itemsFromRun,
  judgeConfigOf,
  judgeItems,
  summarizeJudging,
} from './judging.js';
import { buildReport, judgeNotice, renderMarkdown, summarize, type JudgeReport } from './report.js';
import { runEval, type RunConfig } from './runner.js';

export const DEFAULT_OUT_DIR = fileURLToPath(new URL('../.evals/', import.meta.url));

/** Per request to a real model, like the worker's default. */
const MODEL_TIMEOUT_MS = 60_000;

export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Builds a real provider's model. Only called after the guard allows it. */
  createModel?: typeof createTriageModel;
  fixtures?: readonly Fixture[];
  /** Replaces the real judge's SDK call. Only used after the guard allows a real judge. */
  createJudgeMessage?: CreateMessage;
  now?: () => Date;
  log?: (line: string) => void;
}

function localModel(provider: 'fake' | 'oracle' | 'null', fixtures: readonly Fixture[]) {
  if (provider === 'oracle') {
    return oracleModel(fixtures);
  }
  return provider === 'null' ? nullModel() : new FakeTriageModel();
}

function localConfig(provider: 'fake' | 'oracle' | 'null', model: TriageModel): RunConfig {
  return {
    provider,
    model: model.modelId,
    effort: null,
    promptVersion: model.promptVersion,
    reps: 1,
    seed: 0,
  };
}

/** Runs the CLI. Returns the exit code. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const log =
    deps.log ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const { values } = parseArgs({
    args: [...argv],
    options: {
      provider: { type: 'string', default: 'fake' },
      model: { type: 'string' },
      effort: { type: 'string', default: 'medium' },
      'prompt-version': { type: 'string', default: PROMPT_VERSION },
      reps: { type: 'string', default: '1' },
      seed: { type: 'string', default: '0' },
      concurrency: { type: 'string', default: '4' },
      out: { type: 'string', default: DEFAULT_OUT_DIR },
      'no-cache': { type: 'boolean', default: false },
      judge: { type: 'string' },
    },
    strict: true,
  });

  const fail = (message: string) => {
    log(`eval: ${message}`);
    return 2;
  };
  const provider = values.provider;
  if (!isEvalProvider(provider)) {
    return fail(`unknown provider ${JSON.stringify(provider)}`);
  }
  // Before anything else: no real client is built unless the opt-in is there.
  const guard = checkRealCalls(provider, deps.env);
  if (!guard.allowed) {
    return fail(guard.reason);
  }
  const judgeKind = values.judge;
  if (judgeKind !== undefined && !isJudgeKind(judgeKind)) {
    return fail(`--judge must be one of ${JUDGE_KINDS.join(', ')}`);
  }
  // The judge's guard, also before anything is built or run.
  const created =
    judgeKind === undefined
      ? undefined
      : createSummaryJudge(judgeKind, deps.env, {
          ...(deps.createJudgeMessage && { createMessage: deps.createJudgeMessage }),
          timeoutMs: MODEL_TIMEOUT_MS,
        });
  if (created && 'refused' in created) {
    return fail(created.refused);
  }
  const effort = values.effort;
  if (!(TRIAGE_EFFORTS as readonly string[]).includes(effort)) {
    return fail(`--effort must be one of ${TRIAGE_EFFORTS.join(', ')}`);
  }
  const promptVersion = values['prompt-version'];
  if (!(PROMPT_VERSIONS as readonly string[]).includes(promptVersion)) {
    return fail(`--prompt-version must be one of ${PROMPT_VERSIONS.join(', ')}`);
  }
  const reps = Number(values.reps);
  const seed = Number(values.seed);
  const concurrency = Number(values.concurrency);
  if (![reps, concurrency].every((n) => Number.isInteger(n) && n >= 1 && n <= 32)) {
    return fail('--reps and --concurrency must be whole numbers from 1 to 32');
  }
  if (!Number.isSafeInteger(seed)) {
    return fail('--seed must be a whole number');
  }

  const fixtures = deps.fixtures ?? loadFixtures();
  const outDir = values.out;
  const isLocal = provider === 'fake' || provider === 'oracle' || provider === 'null';

  let model: TriageModel;
  let config: RunConfig;
  if (isLocal) {
    model = localModel(provider, fixtures);
    config = { ...localConfig(provider, model), reps, seed };
  } else {
    const realProvider: Exclude<EvalProvider, 'fake' | 'oracle' | 'null'> = provider;
    const awsRegion = deps.env.AWS_REGION ?? deps.env.AWS_DEFAULT_REGION;
    if (realProvider === 'bedrock' && !awsRegion) {
      return fail('--provider bedrock needs AWS_REGION');
    }
    const modelId = values.model ?? DEFAULT_TRIAGE_MODELS[realProvider];
    model = await (deps.createModel ?? createTriageModel)({
      provider: realProvider,
      model: modelId,
      effort: effort as TriageEffort,
      promptVersion: promptVersion as PromptVersion,
      modelTimeoutMs: MODEL_TIMEOUT_MS,
      ...(awsRegion !== undefined && { awsRegion }),
    });
    config = {
      provider,
      model: model.modelId,
      effort: model.effort,
      promptVersion: model.promptVersion,
      reps,
      seed,
    };
  }

  const abort = new AbortController();
  const onSignal = () => {
    abort.abort(new Error('Interrupted'));
  };
  process.once('SIGINT', onSignal);
  try {
    const cacheDir = isLocal || values['no-cache'] ? undefined : join(outDir, 'cache');
    const run = await runEval({
      fixtures,
      model,
      config,
      ...(cacheDir !== undefined && { cacheDir }),
      concurrency: isLocal ? 1 : concurrency,
      signal: abort.signal,
    });

    const baselines = [];
    for (const name of ['oracle', 'fake', 'null'] as const) {
      if (name === provider) {
        continue;
      }
      const baseline = localModel(name, fixtures);
      const result = await runEval({
        fixtures,
        model: baseline,
        config: localConfig(name, baseline),
      });
      baselines.push(
        summarize(name === 'fake' ? 'fake (keyword baseline)' : name, result, fixtures),
      );
    }
    let judged: { report: JudgeReport; rows: Record<string, readonly unknown[]> } | undefined;
    if (created && judgeKind !== undefined) {
      const { judge } = created;
      const judgeConfig = judgeConfigOf(judgeKind, judge);
      const judgeCacheDir =
        judgeKind === 'fake' || values['no-cache'] ? undefined : join(outDir, 'judge-cache');
      const options = {
        judge,
        config: judgeConfig,
        ...(judgeCacheDir !== undefined && { cacheDir: judgeCacheDir }),
        concurrency: judgeKind === 'fake' ? 1 : concurrency,
        signal: abort.signal,
      };
      const fromRun = itemsFromRun(run, fixtures);
      const runJudged = await judgeItems({ ...options, ...fromRun });
      const set = loadCalibration(fixtures);
      const setJudged = await judgeItems({ ...options, items: calibrationItems(set, fixtures) });
      const runSummary = summarizeJudging(runJudged);
      const result = calibrationResult(set, setJudged);
      judged = {
        report: {
          notice: judgeNotice(runSummary, result),
          run: runSummary,
          calibration: { summary: summarizeJudging(setJudged), result },
        },
        rows: {
          'judgments.jsonl': runJudged.results,
          'calibration.jsonl': setJudged.results,
          'judge-errors.jsonl': [...runJudged.errors, ...setJudged.errors],
        },
      };
    }

    const now = (deps.now ?? (() => new Date()))();
    const report = buildReport(
      summarize(`${provider} (this run)`, run, fixtures),
      baselines,
      fixtures,
      now,
      judged?.report,
    );

    const runDir = join(outDir, 'runs', `${now.toISOString().replaceAll(':', '-')}-${provider}`);
    mkdirSync(runDir, { recursive: true });
    const jsonl = (rows: readonly unknown[]) =>
      rows.map((row) => `${JSON.stringify(row)}\n`).join('');
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(runDir, 'report.md'), renderMarkdown(report));
    writeFileSync(join(runDir, 'results.jsonl'), jsonl(run.results));
    writeFileSync(join(runDir, 'errors.jsonl'), jsonl(run.errors));
    for (const [name, rows] of Object.entries(judged?.rows ?? {})) {
      writeFileSync(join(runDir, name), jsonl(rows));
    }

    const s = report.run;
    log(
      `eval: ${provider}: ${s.scored} scored (${s.answered} answered, ${s.refused} refused, ` +
        `${s.invalid} invalid, ${s.cached} from cache), ${s.infraErrors} infrastructure errors`,
    );
    if (judged) {
      const j = judged.report;
      log(
        `eval: judge ${j.run.config.model}: ${j.run.judged} summaries judged, ` +
          `${j.calibration.result.judged} of ${j.calibration.result.items} calibration items`,
      );
    }
    log(`eval: report in ${runDir}`);
    const judgeErrors = judged?.rows['judge-errors.jsonl']?.length ?? 0;
    if (judgeErrors > 0) {
      log('eval: some judge calls failed for infrastructure reasons (see judge-errors.jsonl)');
      return 1;
    }
    if (run.errors.length > 0) {
      log(
        'eval: some cases failed for infrastructure reasons (see errors.jsonl); rerun to retry them',
      );
      return 1;
    }
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), { env: process.env });
}
