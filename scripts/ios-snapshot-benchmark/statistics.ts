import type { Measurement, RawSample, Summary } from './types.ts';

function percentile(values: number[], percentage: number): number {
  const rank = Math.ceil((percentage / 100) * values.length);
  return values[Math.min(values.length - 1, Math.max(0, rank - 1))]!;
}

export function summarize(values: number[], outlierCount = 0): Summary | null {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  return {
    n: finite.length,
    min: finite[0]!,
    median: percentile(finite, 50),
    p95: percentile(finite, 95),
    max: finite.at(-1)!,
    outlierCount,
    outlierRule: 'tukey-1.5-iqr',
  };
}

function outlierIndexes(values: number[]): Set<number> {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length < 4) return new Set();
  const q1 = percentile(finite, 25);
  const q3 = percentile(finite, 75);
  const spread = q3 - q1;
  const lower = q1 - 1.5 * spread;
  const upper = q3 + 1.5 * spread;
  return new Set(values.flatMap((value, index) => (value < lower || value > upper ? [index] : [])));
}

export function markOutliers(samples: RawSample[]): RawSample[] {
  const indexes = outlierIndexes(
    samples.filter((sample) => sample.ok).map((sample) => sample.wallClockMs),
  );
  let successfulIndex = 0;
  return samples.map((sample) => {
    if (!sample.ok) return { ...sample, outlier: false };
    const outlier = indexes.has(successfulIndex);
    successfulIndex += 1;
    return { ...sample, outlier };
  });
}

export function buildMeasurement(options: {
  transport: Measurement['transport'];
  execution: Measurement['execution'];
  state: Measurement['state'];
  screen: Measurement['screen'];
  sampleMinimum: number;
  operation: Measurement['operation'];
  samples: RawSample[];
  network?: Measurement['network'];
}): Measurement {
  const samples = markOutliers(options.samples);
  const successful = samples.filter((sample) => sample.ok);
  const outlierCount = successful.filter((sample) => sample.outlier).length;
  const failures = samples.length - successful.length;
  const failureCategories: Measurement['failureCategories'] = {};
  for (const sample of samples) {
    const category = sample.failure?.category;
    if (category) failureCategories[category] = (failureCategories[category] ?? 0) + 1;
  }
  return {
    ...options,
    samples,
    wallClockMs: summarize(
      successful.map((sample) => sample.wallClockMs),
      outlierCount,
    ),
    daemonDurationMs: summarize(
      successful.flatMap((sample) =>
        typeof sample.daemonDurationMs === 'number' ? [sample.daemonDurationMs] : [],
      ),
      outlierCount,
    ),
    responseBytes: summarize(
      successful.flatMap((sample) =>
        typeof sample.responseBytes === 'number' ? [sample.responseBytes] : [],
      ),
      outlierCount,
    ),
    failures,
    failureCategories,
  };
}
