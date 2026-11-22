/**
 * `npm run eval -- compare`: two configurations on the same cases, compared case by case.
 *
 *   npm run eval -- compare --a null --b fake                  # illustrative: two local baselines
 *   npm run eval -- compare --a fake --b fake --judge fake     # the judge plumbing, locally
 *   EVAL_REAL_CALLS=1 ANTHROPIC_API_KEY=... npm run eval -- compare \
 *     --a anthropic --a-prompt-version v1 --b anthropic --b-prompt-version v2
 *
 * Each side takes the normal run's options with its letter: `--a-model`, `--a-effort`,
 * `--a-prompt-version`, and the same for `--b-`. `--reps`, `--seed`, `--concurrency`, `--no-cache`,
 * and `--out` apply to both. `--bootstrap-seed` and `--resamples` set the paired bootstrap.
 *
 * With `--judge`, both runs' summaries are scored by the summary judge (compared per case like
 * any metric), and each case's two summaries go to the pairwise judge in both orders.
 *
 * Both sides and the judge pass the real-call guard before anything is built. Output goes to
 * `.evals/comparisons/<time>-<a>-vs-<b>/` (gitignored): `comparison.md`, `comparison.json`,
 * `results-a.jsonl`, `results-b.jsonl`, `errors.jsonl`, and with `--judge`, `pairwise.jsonl`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { serializeError } from '../src/logging.js';
import { PROMPT_VERSION } from '../src/triage/prompt.js';
import { loadFixtures } from './cases.js';
import {
  buildModel,
  choiceError,
  DEFAULT_OUT_DIR,
  MODEL_TIMEOUT_MS,
  type CliDeps,
  type ModelChoice,
} from './cli.js';
import {
  caseValues,
  compareMetrics,
  comparisonNotice,
  DEFAULT_BOOTSTRAP,
  MIN_PAIRED_CASES,
  pairwisePreference,
  renderComparisonMarkdown,
  sideSummary,
  type ComparisonReport,
} from './compare.js';
import { checkRealCalls, isEvalProvider, isJudgeKind, JUDGE_KINDS } from './guard.js';
import { JudgeError } from './judge.js';
import {
  createPairwiseJudge,
  createSummaryJudge,
  itemsFromRun,
  judgeConfigOf,
  judgeItems,
} from './judging.js';
import { comparePair, tallyPairs, type PairVerdict } from './pairwise.js';
import { runEval } from './runner.js';

const side = (letter: 'a' | 'b') =>
  ({
    [letter]: { type: 'string' },
    [`${letter}-model`]: { type: 'string' },
    [`${letter}-effort`]: { type: 'string', default: 'medium' },
    [`${letter}-prompt-version`]: { type: 'string', default: PROMPT_VERSION },
  }) as const;

export async function compareMain(argv: readonly string[], deps: CliDeps): Promise<number> {
  const log =
    deps.log ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const fail = (message: string) => {
    log(`eval compare: ${message}`);
    return 2;
  };
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        ...side('a'),
        ...side('b'),
        reps: { type: 'string', default: '1' },
        seed: { type: 'string', default: '0' },
        concurrency: { type: 'string', default: '4' },
        out: { type: 'string', default: DEFAULT_OUT_DIR },
        'no-cache': { type: 'boolean', default: false },
        judge: { type: 'string' },
        'bootstrap-seed': { type: 'string', default: String(DEFAULT_BOOTSTRAP.seed) },
        resamples: { type: 'string', default: String(DEFAULT_BOOTSTRAP.resamples) },
      },
      strict: true,
    }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const str = (key: string) => {
    const value = values[key];
    return typeof value === 'string' ? value : undefined;
  };

  // Before anything else: both sides' providers and the real-call guard for each.
  const choices: ModelChoice[] = [];
  for (const letter of ['a', 'b'] as const) {
    const provider = str(letter);
    if (provider === undefined) {
      return fail(`--${letter} <provider> is required (fake, oracle, null, anthropic, bedrock)`);
    }
    if (!isEvalProvider(provider)) {
      return fail(`unknown provider ${JSON.stringify(provider)} for --${letter}`);
    }
    const guard = checkRealCalls(provider, deps.env);
    if (!guard.allowed) {
      return fail(`--${letter}: ${guard.reason}`);
    }
    choices.push({
      provider,
      model: str(`${letter}-model`),
      effort: str(`${letter}-effort`) ?? 'medium',
      promptVersion: str(`${letter}-prompt-version`) ?? PROMPT_VERSION,
    });
  }
  const judgeKind = str('judge');
  if (judgeKind !== undefined && !isJudgeKind(judgeKind)) {
    return fail(`--judge must be one of ${JUDGE_KINDS.join(', ')}`);
  }
  const judgeOptions = {
    ...(deps.createJudgeMessage && { createMessage: deps.createJudgeMessage }),
    timeoutMs: MODEL_TIMEOUT_MS,
  };
  const summaryJudge =
    judgeKind === undefined ? undefined : createSummaryJudge(judgeKind, deps.env, judgeOptions);
  if (summaryJudge && 'refused' in summaryJudge) {
    return fail(summaryJudge.refused);
  }
  const pairJudge =
    judgeKind === undefined ? undefined : createPairwiseJudge(judgeKind, deps.env, judgeOptions);
  if (pairJudge && 'refused' in pairJudge) {
    return fail(pairJudge.refused);
  }
  for (const [index, choice] of choices.entries()) {
    const invalid = choiceError(`--${index === 0 ? 'a' : 'b'}-`, choice);
    if (invalid) {
      return fail(invalid);
    }
  }
  const reps = Number(str('reps'));
  const seed = Number(str('seed'));
  const concurrency = Number(str('concurrency'));
  const bootstrapSeed = Number(str('bootstrap-seed'));
  const resamples = Number(str('resamples'));
  if (![reps, concurrency].every((n) => Number.isInteger(n) && n >= 1 && n <= 32)) {
    return fail('--reps and --concurrency must be whole numbers from 1 to 32');
  }
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(bootstrapSeed)) {
    return fail('--seed and --bootstrap-seed must be whole numbers');
  }
  if (!Number.isInteger(resamples) || resamples < 1000 || resamples > 100_000) {
    return fail('--resamples must be a whole number from 1000 to 100000');
  }

  const fixtures = deps.fixtures ?? loadFixtures();
  const outDir = str('out') ?? DEFAULT_OUT_DIR;
  const noCache = values['no-cache'] === true;
  const built = [];
  for (const [index, choice] of choices.entries()) {
    const result = await buildModel(
      `--${index === 0 ? 'a' : 'b'}-`,
      choice,
      { reps, seed },
      deps,
      fixtures,
    );
    if ('error' in result) {
      return fail(result.error);
    }
    built.push(result);
  }

  const abort = new AbortController();
  const onSignal = () => {
    abort.abort(new Error('Interrupted'));
  };
  process.once('SIGINT', onSignal);
  try {
    const runs = [];
    for (const { model, config, isLocal } of built) {
      const cacheDir = isLocal || noCache ? undefined : join(outDir, 'cache');
      runs.push(
        await runEval({
          fixtures,
          model,
          config,
          ...(cacheDir !== undefined && { cacheDir }),
          concurrency: isLocal ? 1 : concurrency,
          signal: abort.signal,
        }),
      );
    }
    const [runA, runB] = runs as [(typeof runs)[number], (typeof runs)[number]];
    const bootstrap = { ...DEFAULT_BOOTSTRAP, seed: bootstrapSeed, resamples };

    let judgedA;
    let judgedB;
    let pairwise: ComparisonReport['pairwise'];
    const pairRows: unknown[] = [];
    const judgeErrors: unknown[] = [];
    if (summaryJudge && pairJudge && judgeKind !== undefined) {
      const local = judgeKind === 'fake';
      const options = {
        judge: summaryJudge.judge,
        config: judgeConfigOf(judgeKind, summaryJudge.judge),
        ...(!local && !noCache && { cacheDir: join(outDir, 'judge-cache') }),
        concurrency: local ? 1 : concurrency,
        signal: abort.signal,
      };
      judgedA = await judgeItems({ ...options, ...itemsFromRun(runA, fixtures) });
      judgedB = await judgeItems({ ...options, ...itemsFromRun(runB, fixtures) });
      judgeErrors.push(...judgedA.errors, ...judgedB.errors);

      // The pairwise judge: each case and rep both sides answered, A as left, B as right.
      const summariesB = new Map(
        itemsFromRun(runB, fixtures).items.map((item) => [item.id, item.input.summary]),
      );
      const verdicts: { caseKey: string; verdict: PairVerdict }[] = [];
      let identical = 0;
      let failed = 0;
      for (const item of itemsFromRun(runA, fixtures).items) {
        const right = summariesB.get(item.id);
        if (right === undefined) {
          continue;
        }
        const key = item.id.slice(0, item.id.lastIndexOf('#'));
        const left = item.input.summary;
        if (left === right) {
          identical += 1;
          verdicts.push({
            caseKey: key,
            verdict: { winner: 'tie', flipped: false, orders: ['tie', 'tie'], usage: [] },
          });
          pairRows.push({ id: item.id, identical: true, winner: 'tie' });
          continue;
        }
        try {
          const verdict = await comparePair(
            pairJudge.judge,
            { issue: item.input.issue, keyPoints: item.input.keyPoints, left, right },
            { signal: abort.signal },
          );
          verdicts.push({ caseKey: key, verdict });
          pairRows.push({ id: item.id, ...verdict, winner: winnerLabel(verdict.winner) });
        } catch (error) {
          abort.signal.throwIfAborted();
          if (error instanceof JudgeError) {
            failed += 1;
            pairRows.push({ id: item.id, failed: error.message });
          } else {
            judgeErrors.push({ id: item.id, pairwise: true, error: serializeError(error) });
          }
        }
      }
      pairwise = {
        judge: { model: pairJudge.judge.modelId, promptVersion: pairJudge.judge.promptVersion },
        tally: { ...tallyPairs(verdicts.map((v) => v.verdict)), identical, failed },
        preference: pairwisePreference(verdicts, bootstrap),
      };
    }

    const cases = fixtures.reduce((total, fixture) => total + fixture.cases.length, 0);
    const now = (deps.now ?? (() => new Date()))();
    const report: ComparisonReport = {
      notice: comparisonNotice(runA.config, runB.config, cases),
      generatedAt: now.toISOString(),
      cases,
      a: sideSummary('A', runA),
      b: sideSummary('B', runB),
      bootstrap,
      minPairedCases: MIN_PAIRED_CASES,
      metrics: compareMetrics(
        caseValues(runA, fixtures, judgedA),
        caseValues(runB, fixtures, judgedB),
        bootstrap,
      ),
      ...(pairwise && { pairwise }),
    };

    const name = `${now.toISOString().replaceAll(':', '-')}-${runA.config.provider}-vs-${runB.config.provider}`;
    const dir = join(outDir, 'comparisons', name);
    mkdirSync(dir, { recursive: true });
    const jsonl = (rows: readonly unknown[]) =>
      rows.map((row) => `${JSON.stringify(row)}\n`).join('');
    writeFileSync(join(dir, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(dir, 'comparison.md'), renderComparisonMarkdown(report));
    writeFileSync(join(dir, 'results-a.jsonl'), jsonl(runA.results));
    writeFileSync(join(dir, 'results-b.jsonl'), jsonl(runB.results));
    writeFileSync(
      join(dir, 'errors.jsonl'),
      jsonl([
        ...runA.errors.map((e) => ({ side: 'A', ...e })),
        ...runB.errors.map((e) => ({ side: 'B', ...e })),
      ]),
    );
    if (pairwise) {
      writeFileSync(join(dir, 'pairwise.jsonl'), jsonl(pairRows));
      writeFileSync(join(dir, 'judge-errors.jsonl'), jsonl(judgeErrors));
    }

    log(
      `eval compare: A ${runA.config.provider} vs B ${runB.config.provider} on ${cases} cases; ` +
        `${report.metrics.filter((m) => m.warnings.length > 0).length} of ${report.metrics.length} metrics carry warnings`,
    );
    log(`eval compare: report in ${dir}`);
    if (judgeErrors.length > 0) {
      log(
        'eval compare: some judge calls failed for infrastructure reasons (see judge-errors.jsonl)',
      );
      return 1;
    }
    if (runA.errors.length > 0 || runB.errors.length > 0) {
      log(
        'eval compare: some cases failed for infrastructure reasons (see errors.jsonl); rerun to retry them',
      );
      return 1;
    }
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
  }
}

const winnerLabel = (winner: PairVerdict['winner']) =>
  winner === 'left' ? 'A' : winner === 'right' ? 'B' : 'tie';
