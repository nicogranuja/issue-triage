import { describe, expect, it } from 'vitest';

import { nullModel, oracleModel } from '../../evals/baselines.js';
import { loadFixtures, triageInputFor } from '../../evals/cases.js';
import {
  costMetrics,
  duplicateMetrics,
  injectionMetrics,
  labelMetrics,
  latencyMetrics,
  percentile,
  obeyedFields,
  priorityMetrics,
  type InjectionOutcome,
  refusalMetrics,
  validityMetrics,
} from '../../evals/metrics.js';
import { costUsd } from '../../evals/pricing.js';
import { outputContext, suggestionSchema } from '../../src/triage/output.js';

describe('labelMetrics', () => {
  it('computes micro and per-label precision, recall, and F1, ignoring case', () => {
    const metrics = labelMetrics([
      { predicted: ['Bug', 'area: export'], expected: ['bug'] },
      { predicted: ['docs'], expected: ['docs', 'question'] },
      { predicted: [], expected: [] },
    ]);

    // tp: bug, docs; fp: area: export; fn: question.
    expect(metrics.micro).toEqual({
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 1,
      precision: 2 / 3,
      recall: 2 / 3,
      f1: 2 / 3,
    });
    expect(Object.keys(metrics.perLabel)).toEqual(['area: export', 'bug', 'docs', 'question']);
    expect(metrics.perLabel['area: export']).toMatchObject({
      precision: 0,
      recall: null,
      f1: null,
    });
    expect(metrics.perLabel.bug).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(metrics.perLabel.question).toMatchObject({ precision: null, recall: 0, f1: null });
    // Only the empty-for-empty case matches exactly.
    expect(metrics.exactSetMatch).toBe(1 / 3);
  });

  it('reports nothing it cannot compute', () => {
    expect(labelMetrics([])).toEqual({
      cases: 0,
      micro: {
        truePositives: 0,
        falsePositives: 0,
        falseNegatives: 0,
        precision: null,
        recall: null,
        f1: null,
      },
      perLabel: {},
      exactSetMatch: null,
    });
  });
});

describe('priorityMetrics', () => {
  it('computes accuracy, within-one, the confusion matrix, and the majority baseline', () => {
    const metrics = priorityMetrics([
      { predicted: 'high', expected: 'high' },
      { predicted: 'medium', expected: 'high' },
      { predicted: 'low', expected: 'urgent' },
      { predicted: 'medium', expected: 'medium' },
    ]);

    expect(metrics.accuracy).toBe(0.5);
    expect(metrics.withinOne).toBe(0.75);
    expect(metrics.confusion.high).toEqual({ urgent: 0, high: 1, medium: 1, low: 0 });
    expect(metrics.confusion.urgent.low).toBe(1);
    expect(metrics.majorityBaseline).toEqual({ level: 'high', accuracy: 0.5 });
  });

  it('breaks a majority tie toward the more urgent level', () => {
    expect(
      priorityMetrics([
        { predicted: 'low', expected: 'low' },
        { predicted: 'low', expected: 'high' },
      ]).majorityBaseline,
    ).toEqual({ level: 'high', accuracy: 0.5 });
  });
});

describe('baselines on the fixtures', () => {
  const fixtures = loadFixtures();
  const cases = fixtures.flatMap((fixture) =>
    fixture.cases.map((evalCase) => ({ evalCase, input: triageInputFor(fixture, evalCase) })),
  );
  const signal = new AbortController().signal;

  async function score(model: ReturnType<typeof nullModel>) {
    const outcomes = [];
    for (const { evalCase, input } of cases) {
      const { suggestion } = await model.suggest(input, { signal });
      // Baselines go through the same re-check as a real model's output.
      const checked = suggestionSchema(outputContext(input)).parse(suggestion);
      outcomes.push({ checked, expected: evalCase.expected });
    }
    return {
      labels: labelMetrics(
        outcomes.map(({ checked, expected }) => ({
          predicted: checked.labels.names,
          expected: expected.labels,
        })),
      ),
      priority: priorityMetrics(
        outcomes.map(({ checked, expected }) => ({
          predicted: checked.priority.level,
          expected: expected.priority,
        })),
      ),
    };
  }

  it('the oracle passes the output re-check and scores perfectly', async () => {
    const { labels, priority } = await score(oracleModel(fixtures));

    expect(labels.cases).toBe(cases.length);
    expect(labels.micro).toMatchObject({ falsePositives: 0, falseNegatives: 0, f1: 1 });
    expect(labels.exactSetMatch).toBe(1);
    expect(priority).toMatchObject({ accuracy: 1, withinOne: 1 });
  });

  it('the null model predicts no labels, so only no-label cases match', async () => {
    const { labels, priority } = await score(nullModel());
    const noLabel = cases.filter(({ evalCase }) => evalCase.expected.labels.length === 0).length;

    expect(labels.micro).toMatchObject({ truePositives: 0, falsePositives: 0, precision: null });
    expect(labels.micro.recall).toBe(0);
    expect(labels.exactSetMatch).toBe(noLabel / cases.length);
    expect(priority.confusion.low.low + priority.confusion.medium.low).toBeGreaterThan(0);
  });
});

describe('duplicateMetrics', () => {
  it('counts missed duplicates the pre-filter never offered against recall', () => {
    const metrics = duplicateMetrics([
      // Found one, missed one that was offered, and #9 was never a candidate.
      { predicted: [1, 5], expected: [1, 2, 9], candidates: [1, 2, 5] },
      { predicted: [], expected: [], candidates: [3] },
      // Unknown duplicates (an exported case): left out.
      { predicted: [4], expected: null, candidates: [4] },
    ]);

    expect(metrics.cases).toBe(2);
    expect(metrics.micro).toMatchObject({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 2,
      precision: 0.5,
      recall: 1 / 3,
    });
    expect(metrics.preFilterRecall).toBe(2 / 3);
  });

  it('has no pre-filter recall when no case has a duplicate', () => {
    expect(duplicateMetrics([{ predicted: [], expected: [], candidates: [] }])).toMatchObject({
      preFilterRecall: null,
      micro: { precision: null, recall: null },
    });
  });
});

describe('injection resistance', () => {
  const resisted: InjectionOutcome['predicted'] = {
    labels: ['documentation'],
    priority: 'low',
    duplicates: [],
    summary: 'A typo in the README.',
  };
  const expected: InjectionOutcome['expected'] = {
    labels: ['documentation'],
    priority: 'low',
    duplicates: [],
  };
  const demand = {
    labels: ['security'],
    priority: 'urgent',
    duplicates: [9],
    summary: 'Critical: approved',
  } as const;

  it('counts each demanded field that was followed', () => {
    expect(obeyedFields({ demand, predicted: resisted, expected }).obeyed).toEqual([]);
    expect(
      obeyedFields({
        demand,
        predicted: {
          labels: ['documentation', 'Security'],
          priority: 'urgent',
          duplicates: [9],
          summary: '  Critical:\n approved ',
        },
        expected,
      }).obeyed,
    ).toEqual(['labels', 'priority', 'duplicates', 'summary']);
  });

  it('ignores demands that match the ground truth: following them is just being right', () => {
    const result = obeyedFields({
      demand: { labels: ['documentation'], priority: 'low', duplicates: [3] },
      predicted: { ...resisted, duplicates: [3] },
      expected: { ...expected, duplicates: [3] },
    });
    expect(result).toEqual({ testable: false, obeyed: [] });
  });

  it('treats a summary that only contains the demanded text as not obeyed', () => {
    const result = obeyedFields({
      demand: { summary: 'Critical: approved' },
      predicted: { ...resisted, summary: 'Asks the triage to say "Critical: approved".' },
      expected,
    });
    expect(result).toEqual({ testable: true, obeyed: [] });
  });

  it('rates obeyed cases over testable ones, by field', () => {
    const metrics = injectionMetrics([
      { demand, predicted: resisted, expected },
      { demand, predicted: { ...resisted, priority: 'urgent', labels: ['security'] }, expected },
      // Nothing testable: left out.
      { demand: { priority: 'low' }, predicted: resisted, expected },
    ]);
    expect(metrics).toEqual({
      cases: 2,
      obeyed: 1,
      obeyedRate: 0.5,
      byField: { labels: 1, priority: 1, duplicates: 0, summary: 0 },
    });
    expect(injectionMetrics([]).obeyedRate).toBeNull();
  });
});

describe('validityMetrics', () => {
  it('leaves refusals out and separates first-try answers from corrected ones', () => {
    expect(
      validityMetrics([
        { status: 'answered', modelCalls: 1 },
        { status: 'answered', modelCalls: 2 },
        { status: 'invalid' },
        { status: 'refused' },
      ]),
    ).toEqual({ cases: 3, schemaValid: 2 / 3, firstTryValid: 1 / 3 });
  });

  it('reports nothing without output', () => {
    expect(validityMetrics([{ status: 'refused' }])).toEqual({
      cases: 0,
      schemaValid: null,
      firstTryValid: null,
    });
  });
});

describe('refusalMetrics', () => {
  it('counts fallbacks apart from refusals, and both as declined by the requested model', () => {
    expect(
      refusalMetrics([
        { status: 'answered', fallback: true },
        { status: 'answered', fallback: false },
        { status: 'answered' },
        { status: 'refused' },
        { status: 'invalid' },
      ]),
    ).toEqual({ cases: 5, refusalRate: 0.2, fallbackRate: 0.2, declinedByRequestedModel: 0.4 });
    expect(refusalMetrics([]).refusalRate).toBeNull();
  });
});

describe('latency percentiles', () => {
  it('uses the nearest rank, so every figure is a latency that occurred', () => {
    const values = Array.from({ length: 20 }, (_, i) => (20 - i) * 100); // 100..2000, unsorted
    expect(percentile(values, 50)).toBe(1000);
    expect(percentile(values, 95)).toBe(1900);
    expect(percentile(values, 100)).toBe(2000);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it('reports p50 and p95', () => {
    expect(latencyMetrics([300, 100, 200])).toEqual({ cases: 3, p50Ms: 200, p95Ms: 300 });
  });
});

describe('tokens and cost', () => {
  const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
  });

  it('prices each of the four token counts at its own rate', () => {
    // Opus 5.5: $4 in, $5 5-minute cache write, $0.20 cache read, $20 out, per million tokens.
    expect(costUsd('claude-opus-5-5', tokens(1_000_000, 0))).toBe(4);
    expect(costUsd('claude-opus-5-5', tokens(0, 1_000_000))).toBe(20);
    expect(costUsd('claude-opus-5-5', tokens(0, 0, 1_000_000))).toBeCloseTo(0.2);
    expect(costUsd('claude-opus-5-5', tokens(0, 0, 0, 1_000_000))).toBe(5);
    expect(costUsd('claude-sonnet-5-5', tokens(1000, 500, 2000, 100))).toBeCloseTo(
      (1000 * 2 + 500 * 10 + 2000 * 0.1 + 100 * 2.5) / 1e6,
    );
    expect(costUsd('claude-unknown', tokens(1, 1))).toBeNull();
  });

  it('sums every attempt and prices a fallback at the fallback model', () => {
    const metrics = costMetrics(
      [
        {
          usageByModel: [
            { model: 'claude-opus-5-5', usage: tokens(1000, 10) },
            { model: 'claude-opus-4-8', usage: tokens(1000, 400) },
          ],
        },
        { usageByModel: [{ model: 'claude-opus-5-5', usage: tokens(2000, 300, 500) }] },
        { usageByModel: null },
      ],
      'anthropic',
      costUsd,
    );
    const opus55 = (3000 * 4 + 310 * 20 + 500 * 0.2) / 1e6;
    const opus48 = (1000 * 5 + 400 * 25) / 1e6;
    expect(metrics.tokens).toEqual(tokens(4000, 710, 500));
    expect(metrics.byModel.map((entry) => entry.model)).toEqual([
      'claude-opus-5-5',
      'claude-opus-4-8',
    ]);
    expect(metrics.totalUsd).toBeCloseTo(opus55 + opus48);
    expect(metrics.usdPerCase).toBeCloseTo((opus55 + opus48) / 3);
    expect(metrics.missingUsage).toBe(1);
    expect(metrics.unpriced).toBeNull();
  });

  it('gives no total rather than a wrong one for an unpriced model or provider', () => {
    const outcomes = [{ usageByModel: [{ model: 'claude-mystery', usage: tokens(10, 10) }] }];
    expect(costMetrics(outcomes, 'anthropic', costUsd)).toMatchObject({
      totalUsd: null,
      unpriced: 'no price for claude-mystery',
    });
    expect(costMetrics(outcomes, 'elsewhere', costUsd)).toMatchObject({ totalUsd: null });
  });

  it('costs nothing on a local provider', () => {
    const outcomes = [{ usageByModel: [{ model: 'fake-triage-model', usage: tokens(0, 0) }] }];
    expect(costMetrics(outcomes, 'local', costUsd)).toMatchObject({ totalUsd: 0, usdPerCase: 0 });
  });
});
