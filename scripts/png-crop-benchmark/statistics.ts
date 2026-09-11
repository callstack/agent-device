import { performance } from 'node:perf_hooks';

/** A timing summary cheap enough to compute on every scenario. */

export type Timing = Readonly<{ medianMs: number; bestMs: number; worstMs: number }>;

export async function measureAsync(rounds: number, run: () => Promise<void>): Promise<Timing> {
  const samples: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  return summarize(samples);
}

export function summarize(samples: readonly number[]): Timing {
  if (samples.length === 0) return { medianMs: 0, bestMs: 0, worstMs: 0 };
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[middle]!
      : ((sorted.at(middle - 1) ?? 0) + (sorted[middle] ?? 0)) / 2;
  return {
    medianMs: median,
    bestMs: sorted[0] ?? 0,
    worstMs: sorted.at(-1) ?? 0,
  };
}

export function speedup(wholeImageMs: number, regionMs: number): number {
  return regionMs > 0 ? wholeImageMs / regionMs : 0;
}
