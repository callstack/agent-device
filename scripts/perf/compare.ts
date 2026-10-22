import { MIN_MEASURED_ROUNDS } from './config.ts';
import { median, scaledMad } from './stats.ts';
import type { Measurement, PerfSummary, Stat } from './types.ts';

export type ComparisonThresholds = {
  // A change must exceed every one of these to be flagged.
  minRelative: number; // fraction of the baseline median
  minAbsoluteMs: number;
  spreadFactor: number; // × night-to-night relative spread (scaled MAD of nightly medians)
  withinFactor: number; // × tonight's cv / √n (standard error of tonight's median)
  minBaselineNights: number; // fewer timed nights give `insufficient-baseline`
  minSamples: number; // successful samples that tonight and each timed night need
};

const DEFAULT_THRESHOLDS: ComparisonThresholds = {
  minRelative: 0.2,
  minAbsoluteMs: 50,
  spreadFactor: 3,
  withinFactor: 2,
  minBaselineNights: 3,
  minSamples: MIN_MEASURED_ROUNDS,
};

export type TimingVerdict =
  | 'regression'
  | 'improvement'
  | 'unchanged'
  | 'insufficient-samples'
  | 'insufficient-baseline'
  | 'new'
  | 'missing';

export type FailureVerdict = 'new-failures' | 'more-failures' | 'fixed' | 'unchanged';

type Flagged = Exclude<TimingVerdict | FailureVerdict, 'unchanged'>;

/** Verdicts that need a reader's attention, in report order. */
const FLAGGED_VERDICTS: readonly Flagged[] = [
  'new-failures',
  'more-failures',
  'regression',
  'fixed',
  'improvement',
];

export type ComparisonRow = {
  id: string;
  scenario: string;
  command: string;
  timing: TimingVerdict;
  // Null when only one side measured the step.
  failures: FailureVerdict | null;
  metric: 'daemon' | 'wall';
  target: { median: number; n: number; cv: number; failures: number; samples: number } | null;
  baseline: {
    median: number;
    nights: number;
    timedNights: number;
    spread: number;
    failingNights: number;
  } | null;
  deltaMs: number | null;
  deltaRelative: number | null;
  threshold: number | null;
};

export type RunRef = {
  label: string;
  runId?: string;
  commit: string;
  startedAt: string;
  device: string;
  xcode?: string;
  rounds: number;
};

const COMPARISON_SCHEMA = 'agent-device-perf-comparison/v1';

export type Comparison = {
  schema: typeof COMPARISON_SCHEMA;
  target: RunRef;
  baseline: RunRef[];
  thresholds: ComparisonThresholds;
  counts: {
    timing: Partial<Record<TimingVerdict, number>>;
    failures: Partial<Record<FailureVerdict, number>>;
  };
  warnings: string[];
  rows: ComparisonRow[];
};

function describeRun(summary: PerfSummary, label: string): RunRef {
  return {
    label,
    runId: summary.metadata.runId,
    commit: summary.metadata.commit,
    startedAt: summary.startedAt,
    device: `${summary.metadata.device.name}${summary.metadata.device.runtime ? ` ${summary.metadata.device.runtime}` : ''}`,
    xcode: summary.metadata.xcode,
    rounds: summary.config.rounds,
  };
}

function metricStat(m: Measurement, metric: 'daemon' | 'wall'): Stat | null {
  return metric === 'daemon' ? m.daemon : m.wallClock;
}

function failureRate(m: Measurement): number {
  return m.samples.length === 0 ? 0 : m.failures / m.samples.length;
}

/**
 * Failures worsen when tonight has more failed samples than every baseline night, both as a count
 * and as a share of samples, so a different round count cannot fake a change.
 */
function judgeFailures(target: Measurement, history: Measurement[]): FailureVerdict {
  const failingNights = history.filter((m) => m.failures > 0).length;
  const worstCount = Math.max(...history.map((m) => m.failures));
  const worstRate = Math.max(...history.map(failureRate));
  if (target.failures > worstCount && failureRate(target) > worstRate)
    return failingNights === 0 ? 'new-failures' : 'more-failures';
  if (target.failures === 0 && failingNights === history.length) return 'fixed';
  return 'unchanged';
}

function compareStep(
  id: string,
  target: Measurement | undefined,
  history: Measurement[],
  thresholds: ComparisonThresholds,
): ComparisonRow {
  const any = target ?? history[0]!;
  const base = { id, scenario: any.scenario, command: any.command };
  const metric: 'daemon' | 'wall' = [target, ...history].every(
    (m) => !m || !m.wallClock || m.daemon,
  )
    ? 'daemon'
    : 'wall';
  const empty = { deltaMs: null, deltaRelative: null, threshold: null };
  const timed = (s: Stat | null): s is Stat => s !== null && s.n >= thresholds.minSamples;
  const timedNights = history
    .map((m) => metricStat(m, metric))
    .filter(timed)
    .map((s) => s.median);
  const baselineMedian = timedNights.length > 0 ? median(timedNights) : null;
  const baseline =
    history.length === 0
      ? null
      : {
          median: baselineMedian ?? Number.NaN,
          nights: history.length,
          timedNights: timedNights.length,
          spread: baselineMedian ? scaledMad(timedNights) / baselineMedian : 0,
          failingNights: history.filter((m) => m.failures > 0).length,
        };
  if (!target)
    return { ...base, timing: 'missing', failures: null, metric, target: null, baseline, ...empty };
  const stat = metricStat(target, metric);
  const targetFacts = {
    median: stat?.median ?? Number.NaN,
    n: stat?.n ?? 0,
    cv: stat?.cv ?? 0,
    failures: target.failures,
    samples: target.samples.length,
  };
  const row = { ...base, metric, target: targetFacts, baseline };
  if (!baseline) return { ...row, timing: 'new', failures: null, ...empty };
  const failures = judgeFailures(target, history);
  if (!stat || baselineMedian === null) {
    const timing = timed(stat) ? 'insufficient-baseline' : 'insufficient-samples';
    return { ...row, timing, failures, ...empty };
  }

  const deltaMs = stat.median - baselineMedian;
  const deltaRelative = baselineMedian === 0 ? 0 : deltaMs / baselineMedian;
  const threshold = Math.max(
    thresholds.minRelative,
    thresholds.spreadFactor * baseline.spread,
    (thresholds.withinFactor * stat.cv) / Math.sqrt(stat.n),
  );
  const measured = { ...row, failures, deltaMs, deltaRelative, threshold };
  if (!timed(stat)) return { ...measured, timing: 'insufficient-samples' };
  if (timedNights.length < thresholds.minBaselineNights) {
    return { ...measured, timing: 'insufficient-baseline' };
  }
  const beyondNoise =
    Math.abs(deltaRelative) > threshold && Math.abs(deltaMs) > thresholds.minAbsoluteMs;
  if (!beyondNoise) return { ...measured, timing: 'unchanged' };
  if (deltaMs > 0) return { ...measured, timing: 'regression' };
  // The samples that still succeed while failures worsen do not show that the step got faster.
  const worsened = failures === 'new-failures' || failures === 'more-failures';
  return { ...measured, timing: worsened ? 'insufficient-samples' : 'improvement' };
}

function environmentWarnings(target: PerfSummary, baseline: PerfSummary[]): string[] {
  const facts = (s: PerfSummary) => ({
    device: `${s.metadata.device.name} ${s.metadata.device.runtime ?? ''}`.trim(),
    xcode: s.metadata.xcode ?? 'none',
    cpu: s.metadata.host.cpu,
  });
  const mine = facts(target);
  const warnings: string[] = [];
  for (const key of ['device', 'xcode', 'cpu'] as const) {
    const differing = baseline.filter((s) => facts(s)[key] !== mine[key]).length;
    if (differing > 0) {
      warnings.push(
        `${differing}/${baseline.length} baseline runs used a different ${key} than tonight (${mine[key]}); their timings are not like for like.`,
      );
    }
  }
  return warnings;
}

/**
 * Compares one run against a rolling baseline of earlier runs. The baseline value of a step is the
 * median of its nightly medians, and its noise is the scaled MAD of those medians. A step is flagged
 * only when its change exceeds the relative floor, the night-to-night spread, tonight's own
 * sampling error, and an absolute floor together. Tonight and every night that counts need
 * `minSamples` successful samples. Failures are judged apart from timing.
 */
export function compareRuns(
  target: { summary: PerfSummary; label: string },
  baseline: { summary: PerfSummary; label: string }[],
  thresholds: ComparisonThresholds = DEFAULT_THRESHOLDS,
): Comparison {
  const targetById = new Map(target.summary.measurements.map((m) => [m.id, m]));
  const ids = [
    ...target.summary.measurements.map((m) => m.id),
    ...baseline.flatMap((b) => b.summary.measurements.map((m) => m.id)),
  ];
  const rows = [...new Set(ids)].map((id) =>
    compareStep(
      id,
      targetById.get(id),
      baseline.flatMap((b) => b.summary.measurements.filter((m) => m.id === id)),
      thresholds,
    ),
  );
  const counts: Comparison['counts'] = { timing: {}, failures: {} };
  for (const row of rows) {
    counts.timing[row.timing] = (counts.timing[row.timing] ?? 0) + 1;
    if (row.failures) counts.failures[row.failures] = (counts.failures[row.failures] ?? 0) + 1;
  }
  return {
    schema: COMPARISON_SCHEMA,
    target: describeRun(target.summary, target.label),
    baseline: baseline.map((b) => describeRun(b.summary, b.label)),
    thresholds,
    counts,
    warnings: environmentWarnings(
      target.summary,
      baseline.map((b) => b.summary),
    ),
    rows,
  };
}

function ms(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(0) : '–';
}

function pct(n: number | null | undefined, signed = false): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  const value = `${(n * 100).toFixed(0)}%`;
  return signed && n > 0 ? `+${value}` : value;
}

function flagRank(row: ComparisonRow): number {
  const ranks = [row.failures, row.timing].map((v) => FLAGGED_VERDICTS.indexOf(v as Flagged));
  const flagged = ranks.filter((rank) => rank >= 0);
  return flagged.length === 0 ? -1 : Math.min(...flagged);
}

function tableRow(row: ComparisonRow): string {
  const failures = row.target ? `${row.target.failures}/${row.target.samples}` : '–';
  const nights = row.baseline ? `${row.baseline.timedNights}/${row.baseline.nights}` : '0';
  return `| ${row.timing} | ${row.failures ?? '–'} | \`${row.id}\` | ${row.metric} | ${ms(row.target?.median)} | ${ms(row.baseline?.median)} | ${ms(row.deltaMs)} | ${pct(row.deltaRelative, true)} | ${pct(row.threshold)} | ${failures} | ${nights} |`;
}

const TABLE_HEAD = [
  '| timing | failures | step | metric | tonight median | baseline median | Δ ms | Δ | threshold | failed tonight | timed nights |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
];

function describeCounts(counts: Partial<Record<string, number>>): string {
  return (
    Object.entries(counts)
      .map(([verdict, n]) => `${n} ${verdict}`)
      .join(', ') || 'none'
  );
}

/** Renders the comparison for the job summary and the artifact. */
export function renderComparison(comparison: Comparison): string {
  const t = comparison.thresholds;
  const flagged = comparison.rows
    .filter((row) => flagRank(row) >= 0)
    .sort((a, b) => flagRank(a) - flagRank(b));
  const lines = [
    `## agent-device perf comparison`,
    '',
    `- **Tonight**: ${comparison.target.label} · ${comparison.target.commit.slice(0, 12)} · ${comparison.target.startedAt} · ${comparison.target.device}`,
    `- **Baseline**: ${comparison.baseline.length === 0 ? 'none' : comparison.baseline.map((b) => `${b.label} (${b.commit.slice(0, 7)})`).join(', ')}`,
    `- **Rule**: flag a step when its median moves by more than max(${pct(t.minRelative)}, ${t.spreadFactor}× night-to-night spread, ${t.withinFactor}× tonight cv/√n) and more than ${t.minAbsoluteMs} ms against the median of the baseline nights; a timing verdict needs ${t.minBaselineNights} nights, and tonight and each of those nights need ${t.minSamples} successful samples. Failures are flagged when tonight has more failed samples than every baseline night, in count and in share.`,
    `- **Timing**: ${describeCounts(comparison.counts.timing)}`,
    `- **Failures**: ${describeCounts(comparison.counts.failures)}`,
    '',
  ];
  for (const warning of comparison.warnings) lines.push(`> ⚠️ ${warning}`, '');
  if (flagged.length > 0) {
    lines.push(...TABLE_HEAD, ...flagged.map(tableRow), '');
  } else {
    lines.push('No step moved beyond its noise threshold.', '');
  }
  lines.push(
    '<details><summary>All steps</summary>',
    '',
    ...TABLE_HEAD,
    ...comparison.rows.map(tableRow),
    '',
    '</details>',
    '',
  );
  return lines.join('\n');
}
