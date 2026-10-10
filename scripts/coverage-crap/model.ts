// Pure pieces of the coverage-based CRAP report: which Istanbul file records fallow can trust,
// and how the touched functions it scores are rendered. run.ts owns the git, fallow and file I/O.

type IstanbulCounters = Readonly<{
  s?: Readonly<Record<string, unknown>>;
  f?: Readonly<Record<string, unknown>>;
  b?: Readonly<Record<string, unknown>>;
}>;

export type IstanbulCoverageMap = Readonly<Record<string, IstanbulCounters>>;

export type SanitizedCoverage = Readonly<{
  map: IstanbulCoverageMap;
  /** Records dropped because a hit count is not a non-negative integer. */
  dropped: readonly string[];
}>;

function isHitCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function countsAreValid(record: IstanbulCounters): boolean {
  const scalars = [...Object.values(record.s ?? {}), ...Object.values(record.f ?? {})];
  const branches = Object.values(record.b ?? {}).flatMap((counts) =>
    Array.isArray(counts) ? counts : [counts],
  );
  return [...scalars, ...branches].every(isHitCount);
}

/**
 * Drops file records whose hit counts are impossible. Vitest's v8 provider merges a module loaded
 * both through its runner and natively into negative or zeroed counts (vitest#11541), and fallow
 * refuses the whole map on one negative count. A dropped file gets no CRAP score rather than a
 * wrong one.
 */
export function sanitizeIstanbulCoverage(map: IstanbulCoverageMap): SanitizedCoverage {
  const kept: Record<string, IstanbulCounters> = {};
  const dropped: string[] = [];
  for (const [file, record] of Object.entries(map)) {
    if (countsAreValid(record)) kept[file] = record;
    else dropped.push(file);
  }
  return { map: kept, dropped: dropped.sort() };
}

export type CrapFinding = Readonly<{
  path: string;
  name: string;
  line: number;
  crap: number;
  cyclomatic: number;
  coveragePct: number | null;
}>;

function readFinding(value: unknown): CrapFinding | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { path, name, line, crap, cyclomatic } = record;
  // Outside the coverage map (tests, scripts, dropped records) fallow estimates from imports.
  if (record.coverage_source !== 'istanbul') return null;
  if (typeof path !== 'string' || typeof name !== 'string') return null;
  if (typeof line !== 'number' || typeof crap !== 'number' || typeof cyclomatic !== 'number') {
    return null;
  }
  const coveragePct = typeof record.coverage_pct === 'number' ? record.coverage_pct : null;
  return { path, name, line, crap, cyclomatic, coveragePct };
}

/** The measured CRAP findings of one `fallow health --format json` report, highest score first. */
export function readCrapFindings(report: unknown, threshold: number): CrapFinding[] {
  const findings =
    typeof report === 'object' && report !== null
      ? (report as { findings?: unknown }).findings
      : undefined;
  if (!Array.isArray(findings)) {
    throw new Error('fallow health report has no findings array');
  }
  return findings
    .map(readFinding)
    .filter((finding): finding is CrapFinding => finding !== null && finding.crap >= threshold)
    .sort((left, right) => right.crap - left.crap || left.path.localeCompare(right.path));
}

function formatCoverage(pct: number | null): string {
  return pct === null ? 'n/a' : `${pct.toFixed(0)}%`;
}

/** `touched` scores the functions a diff changes; `all` scores every function in the map. */
export type CrapScope = 'touched' | 'all';

export function renderCrapReport(input: {
  findings: readonly CrapFinding[];
  dropped: readonly string[];
  threshold: number;
  scope: CrapScope;
}): string {
  const { findings, dropped, threshold, scope } = input;
  const subject = scope === 'touched' ? 'touched function(s)' : 'function(s)';
  const lines = [
    `## Coverage-based CRAP (report-only): ${findings.length === 0 ? 'no' : findings.length} ${subject} at or above ${threshold}`,
    '',
  ];
  if (findings.length > 0) {
    lines.push('| Function | CRAP | Cyclomatic | Coverage |', '| --- | ---: | ---: | ---: |');
    for (const finding of findings) {
      lines.push(
        `| \`${finding.path}:${finding.line}\` ${finding.name} | ${finding.crap.toFixed(1)} | ${finding.cyclomatic} | ${formatCoverage(finding.coveragePct)} |`,
      );
    }
    lines.push(
      '',
      'Add tests for the uncovered branches, or split the function. Code that only runs out of process (workers, browser-evaluated scripts, child processes) measures 0%.',
    );
  }
  if (dropped.length > 0) {
    lines.push(
      '',
      `Unscored: ${dropped.length} file(s) with invalid coverage counts (vitest#11541): ${dropped.map((file) => `\`${file}\``).join(', ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** GitHub Actions warning annotations, one per finding, so the score shows on the diff. */
export function renderCrapAnnotations(findings: readonly CrapFinding[]): string {
  return findings
    .map(
      (finding) =>
        `::warning file=${finding.path},line=${finding.line},title=CRAP ${finding.crap.toFixed(1)}::${finding.name} has cyclomatic ${finding.cyclomatic} at ${formatCoverage(finding.coveragePct)} coverage.\n`,
    )
    .join('');
}
