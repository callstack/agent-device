// The coupling report: affinity, modularity, span, hubs, and family pairs computed twice — over
// all history and over the trailing window — so drift is visible in one document. Pure over the
// history model; build.ts reads the tree and writes the file.

import type { HistoryCommit } from '../repo-history/commits.ts';
import {
  buildAffinity,
  DEFAULT_AFFINITY_OPTIONS,
  type AffinityOptions,
  type CouplingEdge,
  type SkippedCommit,
} from './affinity.ts';
import { couplingHubs, familyPairs, type CouplingHub, type FamilyPair } from './hubs.ts';
import { familyModularity, type FamilyOf } from './modularity.ts';
import { familySpan, type FamilySpan } from './span.ts';

export type Assortativity = { intraShare: number; expected: number; modularity: number };

export type CouplingWindowStats = {
  label: string;
  /** ISO lower bound on committer date; `null` for all history. */
  from: string | null;
  commits: { total: number; touching: number; used: number; skipped: number; maxFiles: number };
  skipped: SkippedCommit[];
  edges: {
    raw: number;
    kept: number;
    minSupport: number;
    crossFamily: number;
    crossFamilyShare: number | null;
  };
  span: FamilySpan;
};

export type CouplingFamilyRow = {
  family: string;
  files: number;
  inWeight: number;
  outWeight: number;
  outInFlow: number | null;
  partners: string[];
  Q: number;
};

export type CouplingReport = {
  generated: { commit: string; date: string; files: number; families: number };
  window: { sinceDays: number; since: CouplingWindowStats; allTime: CouplingWindowStats };
  assortativity: { allTime: Assortativity; since: Assortativity };
  perFamily: CouplingFamilyRow[];
  hubs: CouplingHub[];
  familyPairs: FamilyPair[];
  edges: CouplingEdge[];
};

export type CouplingReportOptions = {
  familyOf: FamilyOf;
  sinceDays: number;
  now: Date;
  affinity?: AffinityOptions;
  hubLimit?: number;
  generated: { commit: string; date: string };
};

/** Reference values from the issue's evidence; a miss is a printed drift warning, never a failure. */
export const DRIFT_REFERENCE = {
  modularity: { min: 0.2, max: 0.35 },
  crossFamilyShareMin: 0.6,
  spanAtLeast5ShareMin: 0.25,
} as const;

function windowStats(
  label: string,
  from: Date | null,
  commits: readonly HistoryCommit[],
  familyOf: FamilyOf,
  affinity: AffinityOptions,
): { stats: CouplingWindowStats; edges: CouplingEdge[]; families: Iterable<string> } {
  const scoped =
    from === null ? commits : commits.filter((commit) => new Date(commit.date) >= from);
  const result = buildAffinity(scoped, affinity);
  const families = new Set(scoped.flatMap((commit) => commit.files.map(familyOf)));
  const modularity = familyModularity(result.edges, familyOf, families);
  return {
    stats: {
      label,
      from: from?.toISOString() ?? null,
      commits: {
        total: scoped.length,
        touching: result.touchingCommits,
        used: result.usedCommits,
        skipped: result.skipped.length,
        maxFiles: affinity.maxFiles,
      },
      skipped: result.skipped,
      edges: {
        raw: result.rawEdges,
        kept: result.edges.length,
        minSupport: affinity.minSupport,
        crossFamily: modularity.crossFamilyEdges,
        crossFamilyShare:
          result.edges.length > 0 ? modularity.crossFamilyEdges / result.edges.length : null,
      },
      span: familySpan(scoped, familyOf, affinity.maxFiles),
    },
    edges: result.edges,
    families,
  };
}

function assortativityOf(edges: readonly CouplingEdge[], familyOf: FamilyOf): Assortativity {
  const { intraShare, expected, modularity } = familyModularity(edges, familyOf, []);
  return { intraShare, expected, modularity };
}

export function buildCouplingReport(
  input: { commits: readonly HistoryCommit[]; files: readonly string[] },
  options: CouplingReportOptions,
): CouplingReport {
  const affinity = options.affinity ?? DEFAULT_AFFINITY_OPTIONS;
  const { familyOf } = options;
  const fileCounts = new Map<string, number>();
  for (const file of input.files) {
    fileCounts.set(familyOf(file), (fileCounts.get(familyOf(file)) ?? 0) + 1);
  }
  const from = new Date(options.now.getTime() - options.sinceDays * 86_400_000);
  const allTime = windowStats('all-time', null, input.commits, familyOf, affinity);
  const since = windowStats(
    `last ${options.sinceDays} days`,
    from,
    input.commits,
    familyOf,
    affinity,
  );
  const modularity = familyModularity(allTime.edges, familyOf, fileCounts.keys());
  return {
    generated: {
      ...options.generated,
      files: input.files.length,
      families: fileCounts.size,
    },
    window: { sinceDays: options.sinceDays, since: since.stats, allTime: allTime.stats },
    assortativity: {
      allTime: assortativityOf(allTime.edges, familyOf),
      since: assortativityOf(since.edges, familyOf),
    },
    perFamily: [...modularity.perFamily.values()].map((row) => ({
      family: row.family,
      files: fileCounts.get(row.family) ?? 0,
      inWeight: row.inWeight,
      outWeight: row.outWeight,
      outInFlow: row.outInFlow,
      partners: row.partners,
      Q: row.Q,
    })),
    hubs: couplingHubs(allTime.edges, familyOf, options.hubLimit ?? 15),
    familyPairs: familyPairs(allTime.edges, familyOf),
    edges: allTime.edges,
  };
}

export function driftWarnings(report: CouplingReport): string[] {
  const warnings: string[] = [];
  const { modularity } = report.assortativity.allTime;
  if (modularity < DRIFT_REFERENCE.modularity.min || modularity > DRIFT_REFERENCE.modularity.max) {
    warnings.push(
      `drift warning: all-time modularity ${modularity.toFixed(3)} is outside the reference ` +
        `${DRIFT_REFERENCE.modularity.min}-${DRIFT_REFERENCE.modularity.max}`,
    );
  }
  const cross = report.window.allTime.edges.crossFamilyShare;
  if (cross === null || cross < DRIFT_REFERENCE.crossFamilyShareMin) {
    warnings.push(
      `drift warning: cross-family edge share ${percent(cross)} is below the reference ` +
        `${percent(DRIFT_REFERENCE.crossFamilyShareMin)}`,
    );
  }
  const wide = report.window.allTime.span.shareAtLeast5;
  if (wide === null || wide < DRIFT_REFERENCE.spanAtLeast5ShareMin) {
    warnings.push(
      `drift warning: share of multi-family commits spanning >= 5 families ${percent(wide)} ` +
        `is below the reference ${percent(DRIFT_REFERENCE.spanAtLeast5ShareMin)}`,
    );
  }
  return warnings;
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function ratio(value: number | null): string {
  return value === null ? '∞' : value.toFixed(1);
}

function windowLines(stats: CouplingWindowStats, assortativity: Assortativity): string[] {
  const { commits, edges, span } = stats;
  const histogram = Object.entries(span.histogram)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([families, count]) => `${families}:${count}`)
    .join(' ');
  return [
    `${stats.label}${stats.from ? ` (since ${stats.from.slice(0, 10)})` : ''}:`,
    `  commits: ${commits.total} total, ${commits.touching} touching production files, ` +
      `${commits.used} used for pairs, ${commits.skipped} skipped (> ${commits.maxFiles} files)`,
    `  edges: ${edges.kept} kept at support >= ${edges.minSupport} (of ${edges.raw} pairs), ` +
      `${edges.crossFamily} cross-family (${percent(edges.crossFamilyShare)})`,
    `  intraShare ${percent(assortativity.intraShare)} vs expected ` +
      `${percent(assortativity.expected)} -> modularity ${assortativity.modularity.toFixed(3)}`,
    `  family span: ${histogram || '(none)'}; ${span.multiFamilyCommits} multi-family commits, ` +
      `median ${span.median ?? 'n/a'}, >= 5 families ${percent(span.shareAtLeast5)}`,
  ];
}

export function formatCouplingSummary(report: CouplingReport, limit = 10): string {
  const lines = [
    `Change coupling: ${report.generated.files} files, ${report.generated.families} families, ` +
      `commit ${report.generated.commit}`,
    ...windowLines(report.window.allTime, report.assortativity.allTime),
    ...windowLines(report.window.since, report.assortativity.since),
  ];
  const skipped = report.window.allTime.skipped;
  if (skipped.length > 0) {
    lines.push(`skipped mass commits (all-time):`);
    for (const commit of skipped) {
      lines.push(`  ${commit.sha.slice(0, 10)} ${commit.files} files  ${commit.subject}`);
    }
  }
  lines.push('per family (all-time; Q = in/W - (s/2W)^2):');
  lines.push('  family                 files     in     out  out/in  partners       Q');
  for (const row of [...report.perFamily].sort((a, b) => b.Q - a.Q)) {
    lines.push(
      `  ${row.family.padEnd(22)} ${String(row.files).padStart(5)} ` +
        `${row.inWeight.toFixed(1).padStart(6)} ${row.outWeight.toFixed(1).padStart(7)} ` +
        `${ratio(row.outInFlow).padStart(7)} ${String(row.partners.length).padStart(8)} ` +
        `${row.Q.toFixed(4).padStart(8)}`,
    );
  }
  lines.push(`top coupling hubs (weight, out-family weight, families reached):`);
  for (const hub of report.hubs.slice(0, limit)) {
    lines.push(
      `  ${hub.weight.toFixed(1).padStart(6)} ${hub.outWeight.toFixed(1).padStart(6)} ` +
        `${String(hub.outFamilies).padStart(3)}  ${hub.id}`,
    );
  }
  lines.push(`heaviest family pairs:`);
  for (const pair of report.familyPairs.slice(0, limit)) {
    lines.push(
      `  ${pair.weight.toFixed(1).padStart(6)} ${pair.edges.toString().padStart(4)} edges  ${pair.a} <-> ${pair.b}`,
    );
  }
  lines.push(...driftWarnings(report));
  lines.push(
    '  (co-change only — not a removability or correctness claim, see scripts/coupling/README.md)',
  );
  return `${lines.join('\n')}\n`;
}
