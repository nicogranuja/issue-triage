import { describe, expect, it } from 'vitest';

import { mean, mulberry32, pairedBootstrap, quantile } from '../../evals/bootstrap.js';

const options = { seed: 7, resamples: 2000, level: 0.95 };

describe('mulberry32', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const draw = (seed: number) => Array.from({ length: 5 }, mulberry32(seed));
    expect(draw(1)).toEqual(draw(1));
    expect(draw(1)).not.toEqual(draw(2));
    for (const value of draw(3)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('quantile', () => {
  it('interpolates linearly between ranks', () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([4], 0.975)).toBe(4);
  });
});

describe('pairedBootstrap', () => {
  const pairs = Array.from({ length: 40 }, (_, i) => [i % 3 === 0 ? 1 : 0, i % 2] as const);

  it('gives the same interval for the same seed, and a different one for another seed', () => {
    const first = pairedBootstrap(pairs, mean, options);
    expect(pairedBootstrap(pairs, mean, options)).toEqual(first);
    const other = pairedBootstrap(pairs, mean, { ...options, seed: 8 });
    expect([other.low, other.high]).not.toEqual([first.low, first.high]);
    expect(first.delta).toBeCloseTo(0.5 - 14 / 40, 10);
  });

  it('a constant per-case difference gives exactly that delta and a zero-width interval', () => {
    // Every case is 0.1 better under B, whatever its level: pairing cancels the level.
    const shifted = Array.from({ length: 25 }, (_, i) => [i / 25, i / 25 + 0.1] as const);
    const interval = pairedBootstrap(shifted, mean, options);
    expect(interval.delta).toBeCloseTo(0.1, 10);
    expect(interval.low).toBeCloseTo(0.1, 10);
    expect(interval.high).toBeCloseTo(0.1, 10);
  });

  it('a known binary delta gets the normal-approximation interval', () => {
    // A is always wrong; B is right on 200 of 400 cases. Delta 0.5, standard error
    // sqrt(0.25 / 400) = 0.025, so the 95% interval is about 0.5 ± 0.049.
    const binary = Array.from({ length: 400 }, (_, i) => [0, i % 2] as const);
    const interval = pairedBootstrap(binary, mean, { seed: 1, resamples: 5000, level: 0.95 });
    expect(interval.delta).toBe(0.5);
    expect(interval.low).toBeGreaterThan(0.44);
    expect(interval.low).toBeLessThan(0.465);
    expect(interval.high).toBeGreaterThan(0.535);
    expect(interval.high).toBeLessThan(0.56);
  });

  it('resamples cases, not sides: the pairing survives every draw', () => {
    // B equals A on every case, so every resample's delta is exactly 0, though the values vary.
    const same = Array.from({ length: 30 }, (_, i) => [i % 5, i % 5] as const);
    const interval = pairedBootstrap(same, mean, options);
    expect([interval.delta, interval.low, interval.high]).toEqual([0, 0, 0]);
  });

  it('counts resamples where the statistic is undefined and leaves them out', () => {
    // A statistic undefined unless the draw includes the one case with value 1.
    const sparse = Array.from(
      { length: 10 },
      (_, i) => [i === 0 ? 1 : 0, i === 0 ? 1 : 0] as const,
    );
    const statistic = (values: readonly number[]) => (values.includes(1) ? mean(values) : null);
    const interval = pairedBootstrap(sparse, statistic, options);
    // P(case 0 never drawn in 10) = 0.9^10, about 35%.
    expect(interval.undefinedResamples / options.resamples).toBeGreaterThan(0.3);
    expect(interval.undefinedResamples / options.resamples).toBeLessThan(0.4);
  });

  it('has no delta or interval with no cases', () => {
    const interval = pairedBootstrap([], mean, options);
    expect(interval).toMatchObject({ n: 0, delta: null, low: null, high: null });
  });
});
