/**
 * A seeded paired bootstrap over cases, for the difference between two configurations.
 *
 * Paired: each case was run under both configurations, so a resample draws cases (with
 * replacement) and takes both configurations' values for the cases drawn. The case-to-case
 * variation that both configurations share (an easy case is easy for both) cancels out of the
 * difference, which is what makes a paired interval narrower than two separate ones.
 *
 * Seeded: the resampling uses a small deterministic generator (mulberry32), so the same seed, the
 * same cases, and the same values always give the same interval.
 *
 * The interval is the percentile interval of the resampled differences. It is known to cover less
 * than its nominal level on small samples, which is one reason the comparison warns below
 * `MIN_PAIRED_CASES` (see `compare.ts`).
 */

/** mulberry32: a 32-bit generator, deterministic for a seed. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Type-7 (linear interpolation) quantile of sorted values. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  const low = sorted[below] ?? Number.NaN;
  const high = sorted[above] ?? Number.NaN;
  return low + (high - low) * (position - below);
}

export interface BootstrapOptions {
  seed: number;
  /** Resamples drawn. */
  resamples: number;
  /** Interval level, such as 0.95. */
  level: number;
}

export interface PairedInterval {
  /** Cases in the pair set. */
  n: number;
  /** `statistic(b) - statistic(a)` over the cases as observed. Null when undefined there. */
  delta: number | null;
  a: number | null;
  b: number | null;
  /** The percentile interval of the resampled deltas. Null when no resample had a delta. */
  low: number | null;
  high: number | null;
  level: number;
  seed: number;
  resamples: number;
  /**
   * Resamples where the statistic was undefined for either side (an F1 with no positives, say).
   * They are left out of the interval, so a large count makes it less trustworthy.
   */
  undefinedResamples: number;
}

/**
 * The paired bootstrap of `statistic(b) - statistic(a)`. `pairs[i]` holds case i's value under
 * each configuration; a resample draws case indices and applies the statistic to each side's
 * values for exactly those indices.
 */
export function pairedBootstrap<V>(
  pairs: readonly (readonly [V, V])[],
  statistic: (values: readonly V[]) => number | null,
  { seed, resamples, level }: BootstrapOptions,
): PairedInterval {
  const n = pairs.length;
  const sideA = pairs.map(([a]) => a);
  const sideB = pairs.map(([, b]) => b);
  const a = n === 0 ? null : statistic(sideA);
  const b = n === 0 ? null : statistic(sideB);
  const delta = a === null || b === null ? null : b - a;
  const base = { n, delta, a, b, level, seed, resamples };
  if (n === 0) {
    return { ...base, low: null, high: null, undefinedResamples: 0 };
  }

  const random = mulberry32(seed);
  const deltas: number[] = [];
  let undefinedResamples = 0;
  const drawnA = new Array<V>(n);
  const drawnB = new Array<V>(n);
  for (let r = 0; r < resamples; r += 1) {
    for (let i = 0; i < n; i += 1) {
      const pair = pairs[Math.floor(random() * n)];
      if (pair === undefined) {
        throw new Error('Bootstrap index out of range');
      }
      drawnA[i] = pair[0];
      drawnB[i] = pair[1];
    }
    const resampledA = statistic(drawnA);
    const resampledB = statistic(drawnB);
    if (resampledA === null || resampledB === null) {
      undefinedResamples += 1;
      continue;
    }
    deltas.push(resampledB - resampledA);
  }
  deltas.sort((x, y) => x - y);
  const alpha = 1 - level;
  return {
    ...base,
    low: deltas.length === 0 ? null : quantile(deltas, alpha / 2),
    high: deltas.length === 0 ? null : quantile(deltas, 1 - alpha / 2),
    undefinedResamples,
  };
}

export const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
