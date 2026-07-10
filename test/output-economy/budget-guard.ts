import type { EconomyMetrics } from './economy-metrics.ts';

export type EconomyBaseline = Readonly<Record<string, EconomyMetrics>>;

export type EconomyBudgetWaiver = {
  bytes?: number;
  lines?: number;
  removed?: true;
  reason: string;
};

export type EconomyBudgetWaivers = Readonly<Record<string, EconomyBudgetWaiver>>;

export type EconomyBudgetIncrease = {
  sample: string;
  metric: 'bytes' | 'lines' | 'sample';
  previous: number;
  current: number;
};

const BUDGET_METRICS = ['bytes', 'lines'] as const;

export function findEconomyBudgetIncreases(
  base: EconomyBaseline,
  candidate: EconomyBaseline,
  waivers: EconomyBudgetWaivers,
): EconomyBudgetIncrease[] {
  return Object.keys(base)
    .sort()
    .flatMap((sample) =>
      compareEconomySample(sample, base[sample]!, candidate[sample], waivers[sample]),
    );
}

export function formatEconomyBudgetIncreases(increases: readonly EconomyBudgetIncrease[]): string {
  return increases
    .map(
      ({ sample, metric, previous, current }) =>
        `${sample} ${metric} increased from ${previous} to ${current}`,
    )
    .join('\n');
}

function compareEconomySample(
  sample: string,
  previous: EconomyMetrics,
  current: EconomyMetrics | undefined,
  waiver: EconomyBudgetWaiver | undefined,
): EconomyBudgetIncrease[] {
  if (!current) {
    return isReviewedWaiver(waiver) && waiver.removed
      ? []
      : [{ sample, metric: 'sample', previous: 1, current: 0 }];
  }
  return BUDGET_METRICS.flatMap((metric) =>
    current[metric] > previous[metric] && !waivesMetric(waiver, metric, current[metric])
      ? [{ sample, metric, previous: previous[metric], current: current[metric] }]
      : [],
  );
}

function waivesMetric(
  waiver: EconomyBudgetWaiver | undefined,
  metric: (typeof BUDGET_METRICS)[number],
  current: number,
): boolean {
  return isReviewedWaiver(waiver) && waiver[metric] === current;
}

function isReviewedWaiver(waiver: EconomyBudgetWaiver | undefined): waiver is EconomyBudgetWaiver {
  return Boolean(waiver?.reason.trim());
}
