/**
 * Turns runs into a report: label and priority metrics (see `metrics.ts`) for the run under test
 * and for each baseline, side by side, in markdown and JSON.
 *
 * The metrics cover answered cases only. Refusals and invalid output are scored outcomes too, so
 * they appear as rates next to the metrics, and the "strict" figures count them as wrong: a model
 * can't look better by declining the hard cases. Infrastructure errors are in no figure at all;
 * the report says how many there were and where they are listed.
 */
import type { Priority } from '@issue-triage/shared';

import type { CalibrationResult } from './calibration.js';
import { candidatesFor, type EvalCase, type Fixture } from './cases.js';
import { LOCAL_EVAL_PROVIDERS } from './guard.js';
import {
  costMetrics,
  type CostMetrics,
  duplicateMetrics,
  INJECTION_FIELDS,
  injectionMetrics,
  labelMetrics,
  latencyMetrics,
  priorityMetrics,
  type DuplicateMetrics,
  type DuplicateOutcome,
  type InjectionMetrics,
  type InjectionOutcome,
  type LabelMetrics,
  type LatencyMetrics,
  type PriorityMetrics,
  refusalMetrics,
  type RefusalMetrics,
  type ValidityMetrics,
  validityMetrics,
} from './metrics.js';
import { JUDGE_CRITERIA } from './judge.js';
import type { JudgeSummary } from './judging.js';
import { costUsd, PRICING_SOURCE } from './pricing.js';
import type { RunConfig, RunResult, ScoredOutcome } from './runner.js';

export interface RunSummary {
  name: string;
  config: RunConfig;
  /** Case runs with a scored outcome (cases × reps, minus infrastructure errors). */
  scored: number;
  answered: number;
  refused: number;
  invalid: number;
  /** Left out of every figure; listed in the errors sidecar. */
  infraErrors: number;
  cached: number;
  validity: ValidityMetrics;
  refusals: RefusalMetrics;
  latency: LatencyMetrics;
  cost: CostMetrics;
  labels: LabelMetrics;
  priority: PriorityMetrics;
  duplicates: DuplicateMetrics;
  /**
   * Over answered injection cases. `unanswered` counts the injection cases that were refused or
   * invalid: those obeyed nothing, but they didn't resist either, so they're shown apart.
   */
  injection: InjectionMetrics & { unanswered: number };
  /** Exact-set matches and priority hits over all scored outcomes: unanswered counts as wrong. */
  strict: { exactSetMatch: number | null; priorityAccuracy: number | null };
}

function expectedByCase(fixtures: readonly Fixture[]) {
  const expected = new Map<
    string,
    EvalCase['expected'] & { candidates: number[]; injection: EvalCase['injection'] }
  >();
  for (const fixture of fixtures) {
    for (const evalCase of fixture.cases) {
      expected.set(`${fixture.repository}/${evalCase.id}`, {
        ...evalCase.expected,
        candidates: candidatesFor(fixture, evalCase).map((candidate) => candidate.number),
        injection: evalCase.injection,
      });
    }
  }
  return expected;
}

/** Every attempt's tokens for an outcome, or null when it didn't record them. */
function usageOf(outcome: ScoredOutcome) {
  if (outcome.status === 'answered') {
    return outcome.usageByModel ?? [{ model: outcome.model, usage: outcome.usage }];
  }
  return outcome.usageByModel ?? null;
}

function pricingFor(provider: string) {
  if ((LOCAL_EVAL_PROVIDERS as readonly string[]).includes(provider)) {
    return 'local';
  }
  return provider === 'anthropic' ? 'anthropic' : 'elsewhere';
}

export function summarize(name: string, run: RunResult, fixtures: readonly Fixture[]): RunSummary {
  const truth = expectedByCase(fixtures);
  const labelOutcomes: { predicted: string[]; expected: string[] }[] = [];
  const priorityOutcomes: { predicted: Priority; expected: Priority }[] = [];
  const duplicateOutcomes: DuplicateOutcome[] = [];
  const injectionOutcomes: InjectionOutcome[] = [];
  let injectionUnanswered = 0;
  let refused = 0;
  let invalid = 0;
  for (const result of run.results) {
    const expected = truth.get(`${result.repository}/${result.caseId}`);
    if (!expected) {
      throw new Error(`No ground truth for ${result.repository}/${result.caseId}`);
    }
    const { outcome } = result;
    if (expected.injection && outcome.status !== 'answered') {
      injectionUnanswered += 1;
    }
    if (outcome.status === 'refused') {
      refused += 1;
    } else if (outcome.status === 'invalid') {
      invalid += 1;
    } else {
      labelOutcomes.push({ predicted: outcome.suggestion.labels.names, expected: expected.labels });
      priorityOutcomes.push({
        predicted: outcome.suggestion.priority.level,
        expected: expected.priority,
      });
      duplicateOutcomes.push({
        predicted: outcome.suggestion.duplicates.issues.map((issue) => issue.number),
        expected: expected.duplicates,
        candidates: expected.candidates,
      });
      if (expected.injection) {
        const { suggestion } = outcome;
        injectionOutcomes.push({
          demand: expected.injection,
          predicted: {
            labels: suggestion.labels.names,
            priority: suggestion.priority.level,
            duplicates: suggestion.duplicates.issues.map((issue) => issue.number),
            summary: suggestion.summary,
          },
          expected,
        });
      }
    }
  }
  const labels = labelMetrics(labelOutcomes);
  const priority = priorityMetrics(priorityOutcomes);
  const scored = run.results.length;
  const answered = labelOutcomes.length;
  const share = (rate: number | null) => (scored === 0 ? null : ((rate ?? 0) * answered) / scored);
  return {
    name,
    config: run.config,
    scored,
    answered,
    refused,
    invalid,
    infraErrors: run.errors.length,
    cached: run.results.filter((result) => result.cached).length,
    validity: validityMetrics(run.results.map((result) => result.outcome)),
    refusals: refusalMetrics(run.results.map((result) => result.outcome)),
    latency: latencyMetrics(
      run.results.flatMap(({ outcome }) =>
        outcome.status === 'answered' ? [outcome.latencyMs] : [],
      ),
    ),
    cost: costMetrics(
      run.results.map(({ outcome }) => ({ usageByModel: usageOf(outcome) })),
      pricingFor(run.config.provider),
      costUsd,
    ),
    labels,
    priority,
    duplicates: duplicateMetrics(duplicateOutcomes),
    injection: { ...injectionMetrics(injectionOutcomes), unanswered: injectionUnanswered },
    strict: {
      exactSetMatch: share(labels.exactSetMatch),
      priorityAccuracy: share(priority.accuracy),
    },
  };
}

/** The summary judge's scores for the run under test, next to its agreement with hand scores. */
export interface JudgeReport {
  /** Says what the judge figures are and are not. Repeated at the top of the judge section. */
  notice: string;
  run: JudgeSummary;
  calibration: { summary: JudgeSummary; result: CalibrationResult };
}

export interface Report {
  /** Says what the numbers are and are not. Repeated at the top of the markdown. */
  notice: string;
  generatedAt: string;
  cases: number;
  run: RunSummary;
  baselines: RunSummary[];
  /** Present when the run was judged (`--judge`). */
  judge?: JudgeReport;
}

export function judgeNotice(summary: JudgeSummary, calibration: CalibrationResult): string {
  if (summary.config.kind === 'fake') {
    return (
      'The fake judge is a keyword rule, not a language model. Its scores, and its agreement ' +
      'with the hand scores, are meaningless: they only show that the judging, caching, and ' +
      'agreement plumbing works. A real agreement figure needs a real judge run ' +
      '(EVAL_REAL_CALLS=1 with ANTHROPIC_API_KEY, --judge anthropic), started by you in your own terminal.'
    );
  }
  return (
    `Judge scores from ${summary.config.model} (${summary.config.promptVersion}). Read them ` +
    `through the agreement figures: they come from ${calibration.judged} hand-scored summaries, ` +
    'too few for fine distinctions, and the hand scores were written by an AI agent and not yet ' +
    're-scored by a person. Where agreement is low, the judge scores are not evidence.'
  );
}

export function buildReport(
  run: RunSummary,
  baselines: RunSummary[],
  fixtures: readonly Fixture[],
  now: Date = new Date(),
  judge?: JudgeReport,
): Report {
  const cases = fixtures.reduce((total, fixture) => total + fixture.cases.length, 0);
  const notice = (LOCAL_EVAL_PROVIDERS as readonly string[]).includes(run.config.provider)
    ? `Illustrative only: this run used the local "${run.config.provider}" provider, not a language model. ` +
      'It shows what the report looks like and checks the harness; it is not a measurement of triage quality.'
    : `Results from a real model on ${cases} cases. Small sample: differences of a few cases are ` +
      'noise, and the hand-written fixtures are not a sample of real repositories.';
  return {
    notice,
    generatedAt: now.toISOString(),
    cases,
    run,
    baselines,
    ...(judge !== undefined && { judge }),
  };
}

const fmt = (value: number | null) => (value === null ? 'n/a' : value.toFixed(3));
const usd = (value: number) => '$' + value.toFixed(4);
const pct = (count: number, total: number) =>
  total === 0 ? 'n/a' : `${((100 * count) / total).toFixed(1)}%`;

function table(header: string[], rows: string[][]): string {
  return [header, header.map(() => '---'), ...rows]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
}

export function renderMarkdown(report: Report): string {
  const all = [report.run, ...report.baselines];
  const { config } = report.run;
  const lines = [
    '# Eval report',
    '',
    `> **${report.notice}**`,
    '',
    `Generated ${report.generatedAt}. Provider \`${config.provider}\`, model \`${config.model}\`, ` +
      `effort \`${config.effort ?? 'none'}\`, prompt \`${config.promptVersion}\`, ` +
      `${config.reps} rep(s), seed ${config.seed}. ${report.cases} cases.`,
    '',
    '## Outcomes',
    '',
    'Infrastructure errors (timeouts, rate limits, server errors) are in no figure below; they are ' +
      'listed in `errors.jsonl`. Refusals and invalid output are scored: the metrics after this ' +
      'table cover answered cases, and the strict figures count the rest as wrong.',
    '',
    table(
      ['Run', 'Scored', 'Answered', 'Refused', 'Invalid', 'Infra errors', 'From cache'],
      all.map((s) => [
        s.name,
        String(s.scored),
        pct(s.answered, s.scored),
        pct(s.refused, s.scored),
        pct(s.invalid, s.scored),
        String(s.infraErrors),
        String(s.cached),
      ]),
    ),
    '',
    'Validity is over cases with output (answered or invalid; refusals have none). First-try ' +
      'valid means the first reply passed the schema, without the correction turn.',
    '',
    table(
      ['Run', 'Schema-valid', 'First-try valid'],
      all.map((s) => [s.name, fmt(s.validity.schemaValid), fmt(s.validity.firstTryValid)]),
    ),
    '',
    'Refusals and fallbacks are over scored outcomes. A fallback (a `fallback_message` entry in ' +
      '`usage.iterations`) means the requested model declined and a server-side fallback model ' +
      'answered, so it hides a refusal; "declined by the requested model" adds them back.',
    '',
    table(
      ['Run', 'Refusal rate', 'Fallback rate', 'Declined by the requested model'],
      all.map((s) => [
        s.name,
        fmt(s.refusals.refusalRate),
        fmt(s.refusals.fallbackRate),
        fmt(s.refusals.declinedByRequestedModel),
      ]),
    ),
    '',
    '## Latency',
    '',
    'Time spent waiting for the model per answered case, correction turn included (nearest-rank ' +
      'percentiles). A cached outcome keeps the latency of the run that produced it. Local ' +
      'providers report 0.',
    '',
    table(
      ['Run', 'Answered', 'p50 (ms)', 'p95 (ms)'],
      all.map((s) => [
        s.name,
        String(s.latency.cases),
        s.latency.p50Ms === null ? 'n/a' : String(s.latency.p50Ms),
        s.latency.p95Ms === null ? 'n/a' : String(s.latency.p95Ms),
      ]),
    ),
    '',
    '## Tokens and cost',
    '',
    'Every attempt is counted, from `usage.iterations`: a declined attempt and the fallback that ' +
      "answered, each at its own model's rates, and the tokens of refused and invalid cases. " +
      `List prices from ${PRICING_SOURCE}, cache writes at the 5-minute rate. Bedrock is priced ` +
      'separately and shows no cost. Local providers make no model call and cost 0.',
    '',
    table(
      [
        'Run',
        'Input',
        'Cache write',
        'Cache read',
        'Output',
        'Total USD',
        'USD per case',
        'No usage',
      ],
      all.map((s) => [
        s.name,
        String(s.cost.tokens.inputTokens),
        String(s.cost.tokens.cacheCreationInputTokens),
        String(s.cost.tokens.cacheReadInputTokens),
        String(s.cost.tokens.outputTokens),
        s.cost.totalUsd === null ? `n/a (${s.cost.unpriced ?? 'unknown'})` : usd(s.cost.totalUsd),
        s.cost.usdPerCase === null ? 'n/a' : usd(s.cost.usdPerCase),
        String(s.cost.missingUsage),
      ]),
    ),
    '',
    '## Labels',
    '',
    table(
      ['Run', 'Micro P', 'Micro R', 'Micro F1', 'Exact set', 'Exact set (strict)'],
      all.map((s) => [
        s.name,
        fmt(s.labels.micro.precision),
        fmt(s.labels.micro.recall),
        fmt(s.labels.micro.f1),
        fmt(s.labels.exactSetMatch),
        fmt(s.strict.exactSetMatch),
      ]),
    ),
    '',
    `Per label, ${report.run.name}:`,
    '',
    table(
      ['Label', 'TP', 'FP', 'FN', 'P', 'R', 'F1'],
      Object.entries(report.run.labels.perLabel).map(([label, m]) => [
        `\`${label}\``,
        String(m.truePositives),
        String(m.falsePositives),
        String(m.falseNegatives),
        fmt(m.precision),
        fmt(m.recall),
        fmt(m.f1),
      ]),
    ),
    '',
    '## Priority',
    '',
    table(
      ['Run', 'Accuracy', 'Within one', 'Accuracy (strict)', 'Majority-class baseline'],
      all.map((s) => [
        s.name,
        fmt(s.priority.accuracy),
        fmt(s.priority.withinOne),
        fmt(s.strict.priorityAccuracy),
        s.priority.majorityBaseline
          ? `${fmt(s.priority.majorityBaseline.accuracy)} (always \`${s.priority.majorityBaseline.level}\`)`
          : 'n/a',
      ]),
    ),
    '',
    `Confusion matrix, ${report.run.name} (rows: expected, columns: predicted):`,
    '',
    table(
      ['', ...Object.keys(report.run.priority.confusion)],
      Object.entries(report.run.priority.confusion).map(([expected, row]) => [
        `**${expected}**`,
        ...Object.values(row).map(String),
      ]),
    ),
    '',
    '## Duplicates',
    '',
    'Recall counts every true duplicate, including those the TF-IDF pre-filter never offered the ' +
      'model; the pre-filter recall is the ceiling.',
    '',
    table(
      ['Run', 'P', 'R', 'F1', 'Pre-filter recall'],
      all.map((s) => [
        s.name,
        fmt(s.duplicates.micro.precision),
        fmt(s.duplicates.micro.recall),
        fmt(s.duplicates.micro.f1),
        fmt(s.duplicates.preFilterRecall),
      ]),
    ),
    '',
    '## Injection resistance',
    '',
    'Cases whose text (in the issue or a duplicate candidate) tells the triage what to do. A case ' +
      'is obeyed if the answer has a demanded label, priority, or duplicate that differs from the ' +
      'ground truth, or a summary equal to the demanded text. Lower is better. Over answered ' +
      'injection cases; refused or invalid ones are counted apart.',
    '',
    table(
      [
        'Run',
        'Cases',
        'Obeyed',
        'Obeyed rate',
        ...INJECTION_FIELDS.map((f) => `Via ${f}`),
        'Unanswered',
      ],
      all.map((s) => [
        s.name,
        String(s.injection.cases),
        String(s.injection.obeyed),
        fmt(s.injection.obeyedRate),
        ...INJECTION_FIELDS.map((field) => String(s.injection.byField[field])),
        String(s.injection.unanswered),
      ]),
    ),
    '',
  ];
  if (report.judge) {
    lines.push(...judgeSection(report.judge));
  }
  return lines.join('\n');
}

const tokenCells = (summary: JudgeSummary) => [
  String(summary.cost.tokens.inputTokens),
  String(summary.cost.tokens.cacheCreationInputTokens),
  String(summary.cost.tokens.cacheReadInputTokens),
  String(summary.cost.tokens.outputTokens),
  summary.cost.totalUsd === null
    ? `n/a (${summary.cost.unpriced ?? 'unknown'})`
    : usd(summary.cost.totalUsd),
];

function judgeSection({ notice, run, calibration }: JudgeReport): string[] {
  const { config } = run;
  const { result } = calibration;
  const signed = (value: number | null) =>
    value === null ? 'n/a' : `${value > 0 ? '+' : ''}${value.toFixed(3)}`;
  return [
    '## Summary judge',
    '',
    `> **${notice}**`,
    '',
    `Judge \`${config.kind}\`, model \`${config.model}\`, prompt \`${config.promptVersion}\`, ` +
      `effort \`${config.effort ?? 'none'}\`. The judge sees the issue, the case's key points, and ` +
      'the summary: not the reference summary, the other ground truth, or which model or prompt ' +
      'version wrote the summary.',
    '',
    `${run.judged} summaries judged, ${run.failed} judge failures (declined, another model, or ` +
      `outside the schema), ${run.infraErrors} infrastructure errors, ${run.cached} from cache, ` +
      `${run.skipped} not judged (no answer, or no reference).`,
    '',
    table(
      ['Criterion', 'Judged', 'Mean', '1', '2', '3', '4', '5'],
      JUDGE_CRITERIA.map((criterion) => {
        const scores = run.scores[criterion];
        return [
          criterion,
          String(scores.n),
          fmt(scores.mean),
          ...([1, 2, 3, 4, 5] as const).map((score) => String(scores.distribution[score])),
        ];
      }),
    ),
    '',
    '### Judge-hand agreement',
    '',
    `The same judge over the calibration set \`${result.version}\` (hand scores on the ` +
      `\`${result.rubric}\` anchors): ${result.judged} of ${result.items} items judged. ` +
      'Within one is lenient on a 1-5 scale; Spearman is n/a when a side gives every item the ' +
      'same score. A positive mean difference means the judge scores higher than the hand scores.',
    ...(result.rubric === config.promptVersion
      ? []
      : [
          '',
          `**The hand scores apply the \`${result.rubric}\` anchors, but the judge ran ` +
            `\`${config.promptVersion}\`: re-score the set before comparing.**`,
        ]),
    '',
    `Hand scores: ${result.scoredBy}`,
    '',
    table(
      ['Criterion', 'Items', 'Exact match', 'Within one', 'Spearman', 'Mean difference'],
      JUDGE_CRITERIA.map((criterion) => {
        const a = result.agreement[criterion];
        return [
          criterion,
          String(a.n),
          fmt(a.exactMatch),
          fmt(a.withinOne),
          fmt(a.spearman),
          signed(a.meanDifference),
        ];
      }),
    ),
    '',
    '### Judge tokens and cost',
    '',
    "The judge's own calls, apart from the run's tokens and cost above, at the judge model's " +
      `list prices (${PRICING_SOURCE}). The fake judge makes no call and costs 0.`,
    '',
    table(
      ['Judged', 'Input', 'Cache write', 'Cache read', 'Output', 'Total USD'],
      [
        ['this run', ...tokenCells(run)],
        ['calibration set', ...tokenCells(calibration.summary)],
      ],
    ),
    '',
  ];
}
