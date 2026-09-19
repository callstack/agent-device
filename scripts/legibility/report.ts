// The legibility report document and its text rendering. Pure over the scored run; run.ts
// assembles the inputs and writes the file.

import type { BatchRun, UnansweredReason } from './batches.ts';
import type { LeakAudit } from './evidence.ts';
import { inputCostUsd } from './jev-client.ts';
import type { Divergence, FamilyRow, Headline, Score, ScoredFile } from './score.ts';

export type LeakReference = {
  condition: string;
  accuracy: number | null;
  answered: number;
  requests: number;
};

/** A second condition evaluated over the same files, reported as a gap rather than a score. */
export type ConditionRun = LeakReference & { delta: number | null };

export type LegibilityReport = {
  generated: {
    commit: string;
    date: string;
    files: number;
    families: number;
    condition: string;
    sample: { size: number; seed: number; all: boolean; ids: string[] };
  };
  /** Scrubber defect rate under the name-withheld condition, against `limit`. */
  leak: LeakAudit & { limit: number };
  /** Share of files whose reader-view evidence already names their own family. */
  nameEcho: LeakAudit;
  requests: { count: number; splits: number; batchSize: number; maxRequests: number };
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  baselines: {
    majority: number | null;
    neighbourVote: number | null;
    knn: number | null;
    model: number | null;
  };
  headline: Headline;
  perFamily: FamilyRow[];
  divergences: Divergence[];
  unanswered: { id: string; reason: UnansweredReason }[];
  ablation: ConditionRun | null;
  leakReferences: LeakReference[];
  files: ScoredFile[];
};

export type ReportInput = {
  generated: LegibilityReport['generated'];
  leak: LeakAudit;
  nameEcho: LeakAudit;
  leakLimit: number;
  run: BatchRun;
  batchSize: number;
  maxRequests: number;
  score: Score;
  ablation: ConditionRun | null;
  leakReferences: LeakReference[];
};

export function buildLegibilityReport(input: ReportInput): LegibilityReport {
  const { headline } = input.score;
  return {
    generated: input.generated,
    leak: { ...input.leak, limit: input.leakLimit },
    nameEcho: input.nameEcho,
    requests: {
      count: input.run.requests,
      splits: input.run.splits,
      batchSize: input.batchSize,
      maxRequests: input.maxRequests,
    },
    usage: {
      inputTokens: input.run.usage.inputTokens,
      outputTokens: input.run.usage.outputTokens,
      costUsd: inputCostUsd(input.run.usage.inputTokens),
    },
    baselines: {
      majority: headline.majority,
      neighbourVote: headline.neighbourVote,
      knn: headline.knn,
      model: headline.model,
    },
    headline,
    perFamily: input.score.perFamily,
    divergences: input.score.divergences,
    unanswered: [...input.run.unanswered].map(([id, reason]) => ({ id, reason })),
    ablation: input.ablation,
    leakReferences: input.leakReferences,
    files: input.score.files,
  };
}

function pct(value: number | null): string {
  return value === null ? '   n/a' : `${(value * 100).toFixed(1)}%`.padStart(6);
}

function num(value: number | null, digits: number): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}`;
}

function headlineLines(report: LegibilityReport): string[] {
  const { generated, headline, leak, nameEcho, requests, usage } = report;
  const excluded =
    headline.excludedSmallFamilyFiles > 0
      ? ` (${headline.excludedSmallFamilyFiles} files in smaller families shown below, not averaged)`
      : '';
  const lines = [
    `Placement legibility: ${generated.files} files, ${generated.families} families, ` +
      `commit ${generated.commit}, condition ${generated.condition}`,
    `  sample: ${generated.sample.size} files` +
      (generated.sample.all ? ' (full tree)' : ` (seed ${generated.sample.seed}, stratified)`),
    `  name echo (reader evidence already names the file's own family): ${nameEcho.leaking.length}/` +
      `${nameEcho.files} files (${(nameEcho.rate * 100).toFixed(2)}%)`,
    `  scrubber defect with names withheld: ${leak.leaking.length}/${leak.files} files ` +
      `(${(leak.rate * 100).toFixed(2)}%, limit ${(leak.limit * 100).toFixed(0)}%)`,
    `  requests: ${requests.count} (batch size ${requests.batchSize}, ${requests.splits} splits, ` +
      `cap ${requests.maxRequests}); unanswered: ${report.unanswered.length}`,
    `  tokens: ${usage.inputTokens} in, ${usage.outputTokens} out; cost $${usage.costUsd.toFixed(4)}`,
    `  accuracy over ${headline.answered} answered files in families with >= 3 samples${excluded}:`,
    `    majority ${pct(headline.majority)}   neighbour-vote ${pct(headline.neighbourVote)}   ` +
      `k-NN ${pct(headline.knn)}   model ${pct(headline.model)}`,
  ];
  if (report.ablation) {
    lines.push(
      `  ${report.ablation.condition}: ${pct(report.ablation.accuracy).trim()} ` +
        `(${signed(report.ablation.delta ?? 0)} vs reader) — the gap is what names carry; the ` +
        `baselines above use those names, so they are not comparable to it`,
    );
  }
  const { spread } = headline;
  if (spread) {
    lines.push(
      `  spread (families with >= 20 samples): best ${spread.best.family} ` +
        `${pct(spread.best.accuracy).trim()}, worst ${spread.worst.family} ` +
        `${pct(spread.worst.accuracy).trim()}, ${spread.points.toFixed(1)} points`,
    );
  }
  return lines;
}

function familyRowLine(row: FamilyRow): string {
  const label = row.family + (row.smallSample ? '*' : '');
  const delta = row.delta === null ? 'n/a' : signed(row.delta);
  const flow = row.outInFlow === null ? '∞' : row.outInFlow.toFixed(1);
  return (
    `  ${label.padEnd(22)} ${String(row.files).padStart(5)} ${String(row.n).padStart(4)} ` +
    `${pct(row.accuracy)} ${pct(row.knn)} ${delta.padStart(7)} ` +
    `${num(row.medianConfidence, 2).padStart(6)} ${num(row.modularity, 4).padStart(7)} ` +
    `${flow.padStart(7)}`
  );
}

function familyLines(rows: readonly FamilyRow[]): string[] {
  const sorted = [...rows].sort(
    (a, b) => (b.accuracy ?? -1) - (a.accuracy ?? -1) || a.family.localeCompare(b.family),
  );
  return [
    'per family (accuracy over answered; * = fewer than 3 samples, not in any headline):',
    '  family                 files    n   model    k-NN   delta   conf       Q  out/in',
    ...sorted.map(familyRowLine),
  ];
}

function divergenceLine(item: Divergence): string {
  const p = item.p === null ? '' : ` p=${item.p.toFixed(2)}`;
  const rename = item.viaRename ? '  via rename' : '';
  return `  ${item.id}  ${item.family} -> ${item.predicted}${p}${rename}  "${item.subject}"`;
}

function unansweredLine(item: LegibilityReport['unanswered'][number]): string {
  const why =
    item.reason.kind === 'request-cap'
      ? `request cap ${item.reason.maxRequests} reached`
      : `${item.reason.errorName}: ${item.reason.message}`;
  return `  ${item.id}  ${item.reason.kind}: ${why}`;
}

function leakReferenceLine(reference: LeakReference): string {
  return (
    `${reference.condition}: ${pct(reference.accuracy).trim()} over ${reference.answered} ` +
    `answered files (${reference.requests} requests) — an upper bound with the answer leaked ` +
    `back in, NOT the score`
  );
}

export function formatLegibilitySummary(report: LegibilityReport, limit = 15): string {
  const truncated = report.divergences.length > limit ? ` (first ${limit})` : '';
  const lines = [
    ...headlineLines(report),
    ...familyLines(report.perFamily),
    `divergences (model and k-NN agree on another family): ${report.divergences.length}${truncated}`,
    ...report.divergences.slice(0, limit).map(divergenceLine),
  ];
  if (report.unanswered.length > 0) {
    lines.push(`unanswered files (${report.unanswered.length}):`);
    lines.push(...report.unanswered.slice(0, limit).map(unansweredLine));
  }
  lines.push(...report.leakReferences.map(leakReferenceLine));
  lines.push(
    '  (placement legibility only — not a removability or correctness claim, see scripts/legibility/README.md)',
  );
  return `${lines.join('\n')}\n`;
}
