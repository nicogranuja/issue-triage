/**
 * How far a judge agrees with hand scores, per criterion. Pure functions over paired 1-5 scores.
 *
 * - Exact match: the share of items where both gave the same score.
 * - Within one: the share where the scores differ by at most 1. On a 1-5 scale this is lenient
 *   (two adjacent anchors are often a judgment call), so read it next to exact match.
 * - Spearman's rank correlation: does the judge order the items the way the hand scores do?
 *   Ties get the average of the ranks they span, and rho is the Pearson correlation of those
 *   ranks (the textbook `1 - 6 sum d^2 / n(n^2 - 1)` shortcut is wrong with ties, which a 1-5
 *   scale always has). Null when either side gives every item the same score: a constant has
 *   no order to agree with.
 * - Mean difference, judge minus hand: positive means the judge is more lenient.
 *
 * None of these say much on a set of 20: one item moves exact match by 5 points.
 */
export interface ScorePair {
  judge: number;
  hand: number;
}

export interface Agreement {
  n: number;
  exactMatch: number | null;
  withinOne: number | null;
  spearman: number | null;
  meanDifference: number | null;
}

/** Ranks from 1, ties sharing the average of the positions they span. */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]?.value === order[start]?.value) {
      end += 1;
    }
    // Positions start..end (0-based) are ranks start+1..end+1; their average:
    const rank = (start + end) / 2 + 1;
    for (let k = start; k <= end; k += 1) {
      const entry = order[k];
      if (entry) {
        ranks[entry.index] = rank;
      }
    }
    start = end + 1;
  }
  return ranks;
}

/** Pearson's correlation, or null when either side has no variance (or fewer than 2 points). */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) {
    return null;
  }
  const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / n;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) {
    return null;
  }
  return sxy / Math.sqrt(sxx * syy);
}

export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  return pearson(averageRanks(xs), averageRanks(ys));
}

export function agreement(pairs: readonly ScorePair[]): Agreement {
  const n = pairs.length;
  if (n === 0) {
    return { n, exactMatch: null, withinOne: null, spearman: null, meanDifference: null };
  }
  const share = (test: (pair: ScorePair) => boolean) => pairs.filter(test).length / n;
  return {
    n,
    exactMatch: share((p) => p.judge === p.hand),
    withinOne: share((p) => Math.abs(p.judge - p.hand) <= 1),
    spearman: spearman(
      pairs.map((p) => p.judge),
      pairs.map((p) => p.hand),
    ),
    meanDifference: pairs.reduce((sum, p) => sum + p.judge - p.hand, 0) / n,
  };
}
