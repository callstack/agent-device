// Pure composition for `pnpm pr:evidence`: every input is something an existing tool already
// produced (the affected selector's JSON, the depgraph report, the layering guard's report, the
// coverage gate's table, the size report). This module turns them into one paste-ready block
// stamped with the exact base and head, and never measures anything itself.

export type GitFacts = Readonly<{
  branch: string;
  head: string;
  headShort: string;
  base: string;
  baseRef: string;
  baseShort: string;
  /** Uncommitted changes exist: the block describes the tree, not the head. */
  dirty: boolean;
  changedFiles: readonly string[];
}>;

export type AffectedPlan = Readonly<{
  failOpen: boolean;
  failOpenReasons: readonly Readonly<{ path: string; rule: string }>[];
  checks: readonly Readonly<{ id: string; localRunnable: boolean; ciJobs: readonly string[] }>[];
}>;

export type DepgraphFacts = Readonly<{
  files: number;
  edges: number;
  typeInversions: number;
  daemonToPlatforms: Readonly<{ count: number; valueCount: number }> | undefined;
}>;

export type LayeringOutcome = Readonly<{
  ok: boolean;
  /** `R9 type-cycle-size` → 1, from the guard's own per-rule lines. */
  violationsByRule: Readonly<Record<string, number>>;
}>;

export type EvidenceInputs = Readonly<{
  generatedAt: string;
  repository: string;
  git: GitFacts;
  affected: AffectedPlan;
  layering: LayeringOutcome;
  depgraph: Readonly<{ head: DepgraphFacts; base: DepgraphFacts | undefined }>;
  /** Markdown the coverage gate printed, or the reason it was not run. */
  coverage: Readonly<{ kind: 'table'; markdown: string } | { kind: 'skipped'; reason: string }>;
  /** Markdown the size report printed, or the reason it was not run. */
  size: Readonly<{ kind: 'table'; markdown: string } | { kind: 'skipped'; reason: string }>;
}>;

/** Top-level area of a repo path: `src/daemon/x.ts` → `src`, `docs/agents/y.md` → `docs`. */
export function groupChangedFiles(paths: readonly string[]): ReadonlyMap<string, number> {
  const groups = new Map<string, number>();
  for (const file of paths) {
    const slash = file.indexOf('/');
    const area = slash === -1 ? '(root)' : file.slice(0, slash);
    groups.set(area, (groups.get(area) ?? 0) + 1);
  }
  return new Map([...groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** The guard prints `  [R9 type-cycle-size] 1 violation(s):` per rule; the OK run prints none. */
export function parseLayeringReport(output: string, exitCode: number): LayeringOutcome {
  const violationsByRule: Record<string, number> = {};
  for (const match of output.matchAll(/^\s*\[([^\]]+)\] (\d+) violation\(s\):/gm)) {
    violationsByRule[match[1] as string] = Number(match[2]);
  }
  return { ok: exitCode === 0, violationsByRule };
}

/** Reads the counts this block reports out of the depgraph JSON report. */
export function depgraphFacts(report: {
  generated: { files: number; edges: number };
  zoneEdges: readonly { from: string; to: string; count: number; valueCount: number }[];
  typeInversions: Record<string, number>;
}): DepgraphFacts {
  const daemonToPlatforms = report.zoneEdges.find(
    (edge) => edge.from === 'daemon-server' && edge.to === 'platforms',
  );
  return {
    files: report.generated.files,
    edges: report.generated.edges,
    typeInversions: Object.values(report.typeInversions).reduce((sum, n) => sum + n, 0),
    daemonToPlatforms: daemonToPlatforms
      ? { count: daemonToPlatforms.count, valueCount: daemonToPlatforms.valueCount }
      : undefined,
  };
}

function delta(head: number, base: number | undefined): string {
  if (base === undefined) return '';
  const diff = head - base;
  return diff === 0 ? ' (±0)' : ` (${diff > 0 ? '+' : ''}${diff} vs base)`;
}

function bullet(text: string): string {
  return `- ${text}`;
}

export function renderEvidence(inputs: EvidenceInputs): string {
  const { git, affected, layering, depgraph } = inputs;
  const areas = [...groupChangedFiles(git.changedFiles)]
    .map(([area, count]) => `${count} ${area}`)
    .join(', ');
  const local = affected.checks.filter((check) => check.localRunnable).map((check) => check.id);
  const remote = affected.checks.filter((check) => !check.localRunnable).map((check) => check.id);
  // A fail-open plan is the whole catalog; naming every id would only bury the reason.
  const affectedLine = affected.failOpen
    ? `fail-open (${[...new Set(affected.failOpenReasons.map((r) => r.rule))].join(', ')}): ` +
      `full set, ${local.length} local + ${remote.length} GitHub-authoritative`
    : `${affected.checks.length} selected` +
      (local.length > 0 ? ` · local: ${local.join(', ')}` : '') +
      (remote.length > 0 ? ` · GitHub-authoritative: ${remote.join(', ')}` : '');
  const layeringLine = layering.ok
    ? 'Layering guard: OK'
    : `Layering guard: ${Object.entries(layering.violationsByRule)
        .map(([rule, count]) => `${rule} ×${count}`)
        .join(', ')}`;
  const head = depgraph.head;
  const base = depgraph.base;
  const daemonEdges = head.daemonToPlatforms
    ? `daemon→platforms ${head.daemonToPlatforms.count} total${delta(head.daemonToPlatforms.count, base?.daemonToPlatforms?.count)}` +
      ` / ${head.daemonToPlatforms.valueCount} value${delta(head.daemonToPlatforms.valueCount, base?.daemonToPlatforms?.valueCount)}`
    : 'daemon→platforms edges: none';

  const lines = [
    `<!-- pr-evidence base=${git.base} head=${git.head} -->`,
    `**Evidence** gathered ${inputs.generatedAt} at \`${git.headShort}\` (\`${git.branch}\`) against \`${git.baseRef}\` @ \`${git.baseShort}\`` +
      (git.dirty ? ' — **working tree dirty: describes the tree, not the head**' : ''),
    bullet(`Changed: ${git.changedFiles.length} files (${areas || 'none'})`),
    bullet(`Affected gates (\`check:affected\`): ${affectedLine}`),
    bullet(
      `${layeringLine} · graph ${head.files} files${delta(head.files, base?.files)}, ` +
        `${head.edges} edges${delta(head.edges, base?.edges)}, ` +
        `type inversions ${head.typeInversions}${delta(head.typeInversions, base?.typeInversions)} · ${daemonEdges}`,
    ),
    bullet(
      inputs.coverage.kind === 'table'
        ? `Changed-line coverage: ${coverageSummary(inputs.coverage.markdown)}`
        : `Coverage: not measured (${inputs.coverage.reason})`,
    ),
    bullet(
      inputs.size.kind === 'table'
        ? `Size: ${sizeSummary(inputs.size.markdown)}`
        : `Size: not measured (${inputs.size.reason})`,
    ),
    bullet(
      `CI on this head (authoritative, not claimed here): https://github.com/${inputs.repository}/commit/${git.head}/checks`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/** `| Changed-line coverage (gating, threshold 80%) | 24/26 (92.31%) |` → `24/26 (92.31%), threshold 80%`. */
export function coverageSummary(markdown: string): string {
  const row = markdown.split('\n').find((line) => line.startsWith('| Changed-line coverage'));
  if (!row) return 'report present, no gating row found';
  const cells = row.split('|').map((cell) => cell.trim());
  const threshold = /threshold (\d+%)/.exec(cells[1] ?? '')?.[1];
  const verdict = /gate: (\w+)/.exec(markdown)?.[1] ?? 'unknown';
  return `${cells[2] ?? '?'}${threshold ? `, threshold ${threshold}` : ''} — ${verdict}`;
}

/** Pulls the JS gzip row's current value and diff out of the size report table. */
export function sizeSummary(markdown: string): string {
  const row = markdown.split('\n').find((line) => line.startsWith('| JS gzip'));
  if (!row) return 'report present, no JS gzip row found';
  const cells = row.split('|').map((cell) => cell.trim());
  return `JS gzip ${cells[3] ?? '?'} (${cells[4] ?? '?'} vs base)`;
}
