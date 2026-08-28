import type { SnapshotBackend } from '@agent-device/kernel/snapshot';
import type { PublicPlatform } from '@agent-device/kernel/device';
import { isRecord } from './json.ts';

const SLOW_SNAPSHOT_P95_WARNING_MS = 1_500;

/** Warm captures needed before chronic slowness is distinguishable from noise. */
const MIN_WARM_SAMPLE_COUNT = 3;

/** Slow warm captures needed before slowness counts as chronic rather than a one-off hiccup. */
const MIN_SLOW_WARM_SAMPLES = 2;

export type SnapshotTimingSample = {
  durationMs: number;
  backend?: SnapshotBackend;
  // approach (b): the PUBLIC leaf platform (ios/macos) surfaced in snapshotDiagnostics, never `apple`.
  platform?: PublicPlatform;
};

export type SnapshotTimingStats = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  slowThresholdMs: number;
  platform?: PublicPlatform;
  backends?: Record<string, number>;
};

export type SnapshotDiagnosticsState = {
  samples: SnapshotTimingSample[];
};

export type SnapshotDiagnosticsSummary = {
  stats: SnapshotTimingStats;
  warning?: string;
};

export function recordSnapshotTiming(
  session: { snapshotDiagnostics?: SnapshotDiagnosticsState } | undefined,
  sample: SnapshotTimingSample,
): void {
  if (!session) return;
  const diagnostics = (session.snapshotDiagnostics ??= { samples: [] });
  diagnostics.samples.push({
    ...sample,
    durationMs: Math.max(0, Math.round(sample.durationMs)),
  });
}

export function summarizeSnapshotDiagnostics(
  session: { snapshotDiagnostics?: SnapshotDiagnosticsState } | undefined,
): SnapshotDiagnosticsSummary | undefined {
  const samples = session?.snapshotDiagnostics?.samples;
  if (!samples || samples.length === 0) return undefined;
  return summarizeSnapshotTimingSamples(samples);
}

export function summarizeSnapshotTimingSamples(
  samples: SnapshotTimingSample[],
): SnapshotDiagnosticsSummary | undefined {
  if (samples.length === 0) return undefined;
  // The first capture folds one-time startup (runner launch, helper install)
  // into its duration, and nearest-rank p95 over a small sample set is just
  // its max — so the warning judges warm captures only, and only once enough
  // exist to mean anything. A single warm outlier is a hiccup, not chronic
  // slowness: the warning additionally needs a quorum of slow warm captures,
  // so nearest-rank-equals-max can never fire it alone. Displayed stats still
  // cover every sample.
  const warm = samples.slice(1);
  const judged = warm.length >= MIN_WARM_SAMPLE_COUNT ? buildSnapshotTimingStats(warm) : undefined;
  const slowWarmCount = warm.filter(
    (sample) => sample.durationMs >= SLOW_SNAPSHOT_P95_WARNING_MS,
  ).length;
  const warns =
    judged !== undefined &&
    judged.p95Ms >= SLOW_SNAPSHOT_P95_WARNING_MS &&
    slowWarmCount >= MIN_SLOW_WARM_SAMPLES;
  return {
    stats: buildSnapshotTimingStats(samples),
    ...(warns && judged ? { warning: formatSlowSnapshotWarning(judged) } : {}),
  };
}

export function mergeSnapshotDiagnostics(
  summaries: Array<SnapshotDiagnosticsSummary | undefined>,
): SnapshotDiagnosticsSummary | undefined {
  const present = summaries.filter(
    (summary): summary is SnapshotDiagnosticsSummary => summary !== undefined,
  );
  const samples = present.flatMap((summary) => samplesFromStats(summary.stats));
  if (samples.length === 0) return undefined;
  const stats = buildSnapshotTimingStats(samples);
  // Reconstructed samples are lossy and order-less (a run's cold start comes
  // back as both its p95 and its max), so only layers holding ordered live
  // samples judge slowness; merge aggregates display stats and carries a
  // warning only when a constituent run judged one itself. The message speaks
  // about the warned runs, never the aggregate — one slow run among many fast
  // ones would otherwise produce "slow: p95 <fast number>".
  const warned = present.filter((summary) => summary.warning);
  return {
    stats,
    ...(warned.length > 0
      ? {
          warning: formatMergedSlowSnapshotWarning({
            warnedCount: warned.length,
            totalCount: present.length,
            worst: warned.reduce((max, summary) => Math.max(max, summary.stats.p95Ms), 0),
            platform: stats.platform,
          }),
        }
      : {}),
  };
}

export function readSnapshotDiagnosticsSummary(
  value: unknown,
): SnapshotDiagnosticsSummary | undefined {
  if (!isRecord(value)) return undefined;
  const stats = readSnapshotTimingStats(value.stats);
  if (!stats) return undefined;
  const warning = typeof value.warning === 'string' ? value.warning : undefined;
  return { stats, ...(warning ? { warning } : {}) };
}

function buildSnapshotTimingStats(samples: SnapshotTimingSample[]): SnapshotTimingStats {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    count: durations.length,
    p50Ms: percentileNearestRank(durations, 50),
    p95Ms: percentileNearestRank(durations, 95),
    maxMs: durations.at(-1) ?? 0,
    slowThresholdMs: SLOW_SNAPSHOT_P95_WARNING_MS,
    ...singlePlatform(samples),
    ...backendCounts(samples),
  };
}

function percentileNearestRank(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const index = Math.max(0, Math.ceil((percentile / 100) * values.length) - 1);
  return values[Math.min(index, values.length - 1)] ?? 0;
}

function singlePlatform(samples: SnapshotTimingSample[]): Pick<SnapshotTimingStats, 'platform'> {
  const platforms = samples
    .map((sample) => sample.platform)
    .filter((platform): platform is PublicPlatform => Boolean(platform));
  const uniquePlatforms = new Set(platforms);
  return uniquePlatforms.size === 1 ? { platform: platforms[0] } : {};
}

function backendCounts(samples: SnapshotTimingSample[]): Pick<SnapshotTimingStats, 'backends'> {
  const backends: Record<string, number> = {};
  for (const sample of samples) {
    if (!sample.backend) continue;
    backends[sample.backend] = (backends[sample.backend] ?? 0) + 1;
  }
  return Object.keys(backends).length > 0 ? { backends } : {};
}

function formatSlowSnapshotWarning(stats: SnapshotTimingStats): string {
  const platform = stats.platform ? `${stats.platform} ` : '';
  return `Warning: ${platform}snapshots are slow in this run: p95 ${stats.p95Ms}ms over ${stats.count} captures. Possible causes: device load, app or dev server stuck, helper fallback, or stale daemon.`;
}

function formatMergedSlowSnapshotWarning(params: {
  warnedCount: number;
  totalCount: number;
  worst: number;
  platform?: PublicPlatform;
}): string {
  const platform = params.platform ? `${params.platform} ` : '';
  return `Warning: ${platform}snapshots were slow in ${params.warnedCount} of ${params.totalCount} runs (worst run p95 ${params.worst}ms). Possible causes: device load, app or dev server stuck, helper fallback, or stale daemon.`;
}

function readSnapshotTimingStats(value: unknown): SnapshotTimingStats | undefined {
  if (!isRecord(value)) return undefined;
  const required = readRequiredSnapshotTimingStats(value);
  if (!required) return undefined;
  return {
    ...required,
    ...readOptionalSnapshotTimingStats(value),
  };
}

function readRequiredSnapshotTimingStats(
  record: Record<string, unknown>,
):
  | Pick<SnapshotTimingStats, 'count' | 'p50Ms' | 'p95Ms' | 'maxMs' | 'slowThresholdMs'>
  | undefined {
  const entries = {
    count: record.count,
    p50Ms: record.p50Ms,
    p95Ms: record.p95Ms,
    maxMs: record.maxMs,
    slowThresholdMs: record.slowThresholdMs,
  };
  if (Object.values(entries).some((value) => typeof value !== 'number')) return undefined;
  return entries as Pick<
    SnapshotTimingStats,
    'count' | 'p50Ms' | 'p95Ms' | 'maxMs' | 'slowThresholdMs'
  >;
}

function readBackendCounts(value: Record<string, unknown>): Record<string, number> | undefined {
  const entries = Object.entries(value).filter((entry): entry is [string, number] => {
    return typeof entry[1] === 'number';
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readOptionalSnapshotTimingStats(
  record: Record<string, unknown>,
): Pick<SnapshotTimingStats, 'platform' | 'backends'> {
  const platform = typeof record.platform === 'string' ? record.platform : undefined;
  const backends = isRecord(record.backends) ? readBackendCounts(record.backends) : undefined;
  return {
    ...(platform ? { platform: platform as SnapshotTimingStats['platform'] } : {}),
    ...(backends ? { backends } : {}),
  };
}

function samplesFromStats(stats: SnapshotTimingStats | undefined): SnapshotTimingSample[] {
  if (!stats || stats.count <= 0) return [];
  const platform = stats.platform;
  if (stats.count === 1) return [{ durationMs: stats.maxMs, platform }];
  if (stats.count === 2) {
    return [
      { durationMs: stats.p50Ms, platform },
      { durationMs: stats.maxMs, platform },
    ];
  }
  return [
    ...Array.from({ length: stats.count - 3 }, () => ({ durationMs: stats.p50Ms, platform })),
    { durationMs: stats.p50Ms, platform },
    { durationMs: stats.p95Ms, platform },
    { durationMs: stats.maxMs, platform },
  ];
}
