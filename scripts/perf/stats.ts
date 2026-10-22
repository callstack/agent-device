import type { Stat } from './types.ts';

// Nearest-rank percentile over sorted values.
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

/**
 * Describes one sample set. `stddev` is the sample standard deviation (n − 1), so it is 0 for a
 * single value; `cv` is stddev / mean and is 0 when the mean is 0.
 */
export function summarize(values: number[]): Stat | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n;
  const variance = n > 1 ? sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  return {
    n,
    mean,
    stddev,
    cv: mean === 0 ? 0 : stddev / mean,
    median: middle(sorted),
    min: sorted[0]!,
    max: sorted.at(-1)!,
    p95: percentile(sorted, 95),
  };
}

// The median of sorted values; an even count averages the two middle values.
function middle(sorted: number[]): number {
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
}

export function median(values: number[]): number {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : middle(sorted);
}

/** Median absolute deviation scaled to estimate a normal standard deviation. */
export function scaledMad(values: number[]): number {
  const center = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - center)));
}
