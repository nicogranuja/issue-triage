import { describe, expect, it } from 'vitest';

import { agreement, averageRanks, spearman } from '../../evals/agreement.js';

const pairs = (judge: number[], hand: number[]) =>
  judge.map((j, i) => ({ judge: j, hand: hand[i] ?? 0 }));

describe('agreement, against values worked out by hand', () => {
  it('judge 1 2 3 4 5 against hand 1 3 3 5 4', () => {
    // Exact: items 1 and 3 (2 of 5). Within one: every difference is 0 or 1.
    // Hand ranks with the tie at 3 averaged: 1, 2.5, 2.5, 5, 4. Judge ranks: 1 2 3 4 5.
    // Deviations from the mean rank 3: judge -2 -1 0 1 2; hand -2 -0.5 -0.5 2 1.
    // Sxy = 4 + 0.5 + 0 + 2 + 2 = 8.5; Sxx = 10; Syy = 4 + 0.25 + 0.25 + 4 + 1 = 9.5.
    // rho = 8.5 / sqrt(95). Mean difference: (0 - 1 + 0 - 1 + 1) / 5 = -0.2.
    const result = agreement(pairs([1, 2, 3, 4, 5], [1, 3, 3, 5, 4]));
    expect(result.n).toBe(5);
    expect(result.exactMatch).toBe(0.4);
    expect(result.withinOne).toBe(1);
    expect(result.spearman).toBeCloseTo(8.5 / Math.sqrt(95), 12);
    expect(result.spearman).toBeCloseTo(0.872082, 6);
    expect(result.meanDifference).toBeCloseTo(-0.2, 12);
  });

  it('ties on both sides: judge 2 2 4 4 5 against hand 1 2 3 4 3', () => {
    // Exact: items 2 and 4 (2 of 5). Within one: all but item 5 (5 vs 3), so 4 of 5.
    // Judge ranks: 1.5 1.5 3.5 3.5 5. Hand ranks: 1 2 3.5 5 3.5. Both means are 3.
    // Judge deviations: -1.5 -1.5 0.5 0.5 2; hand: -2 -1 0.5 2 0.5.
    // Sxy = 3 + 1.5 + 0.25 + 1 + 1 = 6.75; Sxx = 2.25 * 2 + 0.25 * 2 + 4 = 9;
    // Syy = 4 + 1 + 0.25 + 4 + 0.25 = 9.5. rho = 6.75 / sqrt(85.5).
    // Mean difference: (1 + 0 + 1 + 0 + 2) / 5 = 0.8 (the judge is more lenient).
    const result = agreement(pairs([2, 2, 4, 4, 5], [1, 2, 3, 4, 3]));
    expect(result.exactMatch).toBe(0.4);
    expect(result.withinOne).toBe(0.8);
    expect(result.spearman).toBeCloseTo(6.75 / Math.sqrt(85.5), 12);
    expect(result.meanDifference).toBeCloseTo(0.8, 12);
  });

  it('averages tied ranks', () => {
    expect(averageRanks([3, 1, 3, 2, 3])).toEqual([4, 1, 4, 2, 4]);
    expect(averageRanks([5, 5])).toEqual([1.5, 1.5]);
  });

  it('is -1 for a reversed order, and null when a side is constant or there is one item', () => {
    expect(spearman([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
    expect(spearman([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 12);
    expect(agreement(pairs([5, 5, 5], [1, 3, 5])).spearman).toBeNull();
    expect(agreement(pairs([4], [4]))).toMatchObject({ n: 1, exactMatch: 1, spearman: null });
    expect(agreement([])).toEqual({
      n: 0,
      exactMatch: null,
      withinOne: null,
      spearman: null,
      meanDifference: null,
    });
  });
});
