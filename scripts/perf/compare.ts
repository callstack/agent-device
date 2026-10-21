import { median, scaledMad } from './stats.ts';
import type { Measurement, PerfSummary, Stat } from './types.ts';

export type ComparisonThresholds = {
  // A change must exceed every one of these to be flagged.
  minRelative: number; // fraction of the baseline median
  minAbsoluteMs: number;
  spreadFactor: number; // × night-to-night relative spread (scaled MAD of nightly medians)
  withinFactor: number; // × tonight's cv / √n (standard error of tonight's median)
  minBaselineNights: number; // fewer nights give `insufficient-baseline`
};

const DEFAULT_THRESHOLDS: ComparisonThresholds = {
  minRelative: 0.2,
  minAbsoluteMs: 50,
  spreadFactor: 3,
  withinFactor: 2,
  minBaselineNights: 3,
};

export type Verdict =
  | 'regression'
  | 'improvement'
  | 'unchanged'
  | 'new-failures'
  | 'fixed'
  | 'failing'
  | 'insufficient-baseline'
  | 'new'
  | 'missing';

/** Verdicts that need a reader's attention, in report order. */
const FLAGGED_VERDICTS: readonly Verdict[] = ['new-failures', 'regression', 'fixed', 'improvement'];

export type ComparisonRow = {
  id: string;
  scenario: string;
  command: string;
  verdict: Verdict;
  metric: 'daemon' | 'wall';
  target: { median: number; n: number; cv: number; failures: number; samples: number } | null;
  baseline: { median: number; nights: number; spread: number; failingNights: number } | null;
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
  counts: Partial<Record<Verdict, number>>;
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
  const okNights = history
    .map((m) => metricStat(m, metric))
    .filter((s): s is Stat => s !== null)
    .map((s) => s.median);
  const failingNights = history.filter((m) => m.failures > 0).length;
  const baselineMedian = okNights.length > 0 ? median(okNights) : null;
  const baseline =
    history.length === 0
      ? null
      : {
          median: baselineMedian ?? Number.NaN,
          nights: history.length,
          spread: baselineMedian ? scaledMad(okNights) / baselineMedian : 0,
          failingNights,
        };
  if (!target) return { ...base, verdict: 'missing', metric, target: null, baseline, ...empty };
  const stat = metricStat(target, metric);
  const targetFacts = stat
    ? {
        median: stat.median,
        n: stat.n,
        cv: stat.cv,
        failures: target.failures,
        samples: target.samples.length,
      }
    : {
        median: Number.NaN,
        n: 0,
        cv: 0,
        failures: target.failures,
        samples: target.samples.length,
      };
  const row = { ...base, metric, target: targetFacts, baseline };
  if (!baseline) return { ...row, verdict: 'new', ...empty };
  if (target.failures > 0 && failingNights === 0)
    return { ...row, verdict: 'new-failures', ...empty };
  if (target.failures === 0 && failingNights === history.length)
    return { ...row, verdict: 'fixed', ...empty };
  if (!stat || baselineMedian === null) return { ...row, verdict: 'failing', ...empty };

  const deltaMs = stat.median - baselineMedian;
  const deltaRelative = baselineMedian === 0 ? 0 : deltaMs / baselineMedian;
  const threshold = Math.max(
    thresholds.minRelative,
    thresholds.spreadFactor * baseline.spread,
    (thresholds.withinFactor * stat.cv) / Math.sqrt(stat.n),
  );
  const measured = { deltaMs, deltaRelative, threshold };
  if (okNights.length < thresholds.minBaselineNights) {
    return { ...row, verdict: 'insufficient-baseline', ...measured };
  }
  const beyondNoise =
    Math.abs(deltaRelative) > threshold && Math.abs(deltaMs) > thresholds.minAbsoluteMs;
  const verdict: Verdict = !beyondNoise ? 'unchanged' : deltaMs > 0 ? 'regression' : 'improvement';
  return { ...row, verdict, ...measured };
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
 * sampling error, and an absolute floor together.
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
  const counts: Partial<Record<Verdict, number>> = {};
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
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

function tableRow(row: ComparisonRow): string {
  const failures = row.target && row.target.failures > 0 ? ` (${row.target.failures} failed)` : '';
  return `| ${row.verdict} | \`${row.id}\` | ${row.metric} | ${ms(row.target?.median)}${failures} | ${ms(row.baseline?.median)} | ${ms(row.deltaMs)} | ${pct(row.deltaRelative, true)} | ${pct(row.threshold)} | ${row.baseline?.nights ?? 0} |`;
}

const TABLE_HEAD = [
  '| verdict | step | metric | tonight median | baseline median | Δ ms | Δ | threshold | nights |',
  '|---|---|---|---|---|---|---|---|---|',
];

/** Renders the comparison for the job summary and the artifact. */
export function renderComparison(comparison: Comparison): string {
  const t = comparison.thresholds;
  const flagged = comparison.rows
    .filter((row) => FLAGGED_VERDICTS.includes(row.verdict))
    .sort((a, b) => FLAGGED_VERDICTS.indexOf(a.verdict) - FLAGGED_VERDICTS.indexOf(b.verdict));
  const counts = Object.entries(comparison.counts)
    .map(([verdict, n]) => `${n} ${verdict}`)
    .join(', ');
  const lines = [
    `## agent-device perf comparison`,
    '',
    `- **Tonight**: ${comparison.target.label} · ${comparison.target.commit.slice(0, 12)} · ${comparison.target.startedAt} · ${comparison.target.device}`,
    `- **Baseline**: ${comparison.baseline.length === 0 ? 'none' : comparison.baseline.map((b) => `${b.label} (${b.commit.slice(0, 7)})`).join(', ')}`,
    `- **Rule**: flag a step when its median moves by more than max(${pct(t.minRelative)}, ${t.spreadFactor}× night-to-night spread, ${t.withinFactor}× tonight cv/√n) and more than ${t.minAbsoluteMs} ms against the median of the baseline nights; at least ${t.minBaselineNights} nights are needed for a verdict.`,
    `- **Steps**: ${counts || 'none'}`,
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
