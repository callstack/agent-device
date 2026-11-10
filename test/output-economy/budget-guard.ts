import type { EconomyMetrics } from './economy-metrics.ts';

export type EconomyBaseline = Readonly<Record<string, EconomyMetrics>>;

/** One reviewed raise: it applies only while the budget floor still equals `from`. */
export type EconomyMetricRaise = {
  from: number;
  to: number;
};

export type EconomyBudgetWaiver = {
  bytes?: EconomyMetricRaise;
  lines?: EconomyMetricRaise;
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
    current[metric] > previous[metric] &&
    !waivesMetric(waiver, metric, previous[metric], current[metric])
      ? [{ sample, metric, previous: previous[metric], current: current[metric] }]
      : [],
  );
}

function waivesMetric(
  waiver: EconomyBudgetWaiver | undefined,
  metric: (typeof BUDGET_METRICS)[number],
  previous: number,
  current: number,
): boolean {
  const raise = isReviewedWaiver(waiver) ? waiver[metric] : undefined;
  return raise !== undefined && raise.from === previous && raise.to === current;
}

function isReviewedWaiver(waiver: EconomyBudgetWaiver | undefined): waiver is EconomyBudgetWaiver {
  return Boolean(waiver?.reason.trim());
}
