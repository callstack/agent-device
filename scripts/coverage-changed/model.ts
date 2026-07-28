// Pure model for the changed-line coverage gate (#1418).
//
// Joins a unified=0 diff (base...HEAD) with vitest's lcov coverage report to
// score coverage of the CHANGED LINES ONLY, per file. Only added (new-side)
// lines count; deleted lines never do, so the gate is deterministic against
// renames and deletes. The gate fails when changed-line coverage drops below
// CHANGED_LINE_COVERAGE_THRESHOLD; run.ts owns all I/O so this stays testable
// with fixture strings.
//
// The coverable universe is sourced from the lcov report itself, not a second
// copy of vitest's exclude globs: vitest runs coverage with `all` on, so every
// includable `src/**/*.ts` file appears in lcov even when untested. A changed
// includable source file that is ABSENT from lcov was therefore dropped by an
// exclude glob — which is exactly the "excluded path" we report (non-gating) so
// exclusions cannot silently absorb new logic.

// Single source of truth for the gate. Changed-line coverage below this
// percentage fails the Coverage CI job (unless waived).
export const CHANGED_LINE_COVERAGE_THRESHOLD = 70;

export type LcovFile = {
  readonly path: string;
  // new-side line number -> hit count (v8 only emits DA for executable lines,
  // so a line absent here is non-executable or ignored).
  readonly lineHits: ReadonlyMap<number, number>;
  // One entry per BRDA record: the line it sits on and whether it was taken.
  readonly branches: readonly { readonly line: number; readonly taken: number }[];
};

export type CoverageIndex = ReadonlyMap<string, LcovFile>;

export type ChangedFileDiff = {
  readonly path: string;
  // New-side line numbers of '+' lines, ascending and de-duplicated.
  readonly added: readonly number[];
  // `+++ /dev/null`: the file was deleted, so it contributes no changed lines.
  readonly deleted: boolean;
};

// Normalize an lcov/diff path to a repo-relative posix path. `rootDir` strips an
// absolute-path prefix some coverage providers emit; `./` and `b/` prefixes are
// dropped so lcov and diff paths join on the same key.
export function normalizePath(raw: string, rootDir?: string): string {
  let p = raw.trim().replace(/\\/g, '/');
  if (rootDir) {
    const root = rootDir.replace(/\\/g, '/').replace(/\/$/, '');
    if (p === root) return '';
    if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  }
  if (p.startsWith('b/')) p = p.slice(2);
  if (p.startsWith('./')) p = p.slice(2);
  return p;
}

export function parseLcov(text: string, rootDir?: string): CoverageIndex {
  const index = new Map<string, LcovFile>();
  let path: string | null = null;
  let lineHits = new Map<number, number>();
  let branches: { line: number; taken: number }[] = [];
  const flush = (): void => {
    if (path !== null) index.set(path, { path, lineHits, branches });
    path = null;
    lineHits = new Map();
    branches = [];
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      flush();
      path = normalizePath(line.slice(3), rootDir);
    } else if (line.startsWith('DA:')) {
      const [lineNo, hits] = line.slice(3).split(',');
      const n = Number(lineNo);
      const h = Number(hits);
      if (Number.isFinite(n) && Number.isFinite(h)) lineHits.set(n, h);
    } else if (line.startsWith('BRDA:')) {
      // BRDA:<line>,<block>,<branch>,<taken>; taken is '-' when never reached.
      const parts = line.slice(5).split(',');
      const lineNo = Number(parts[0]);
      const takenRaw = parts[3];
      const taken = takenRaw === '-' || takenRaw === undefined ? 0 : Number(takenRaw);
      if (Number.isFinite(lineNo))
        branches.push({ line: lineNo, taken: Number.isFinite(taken) ? taken : 0 });
    } else if (line === 'end_of_record') {
      flush();
    }
  }
  flush();
  return index;
}

// Parse `git diff --unified=0` output into the added (new-side) line numbers per
// file. Renames with edits report their added lines under the destination path;
// pure renames and deletions contribute nothing.
export function parseUnifiedDiff(diff: string): ChangedFileDiff[] {
  const files: ChangedFileDiff[] = [];
  let current: { path: string; added: Set<number>; deleted: boolean } | null = null;
  let newLineCursor = 0;
  const push = (): void => {
    if (current && current.path) {
      files.push({
        path: current.path,
        added: [...current.added].sort((a, b) => a - b),
        deleted: current.deleted,
      });
    }
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      push();
      // Seed the path from the header's b/ side so deleted files (whose `+++` is
      // /dev/null) still carry a path; a real `+++ b/<path>` refines it below.
      const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      current = { path: header ? normalizePath(header[1]!) : '', added: new Set(), deleted: false };
      newLineCursor = 0;
    } else if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (current) {
        if (target === '/dev/null') current.deleted = true;
        else current.path = normalizePath(target);
      }
    } else if (line.startsWith('@@')) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) newLineCursor = Number(match[1]);
    } else if (current && line.startsWith('+') && !line.startsWith('+++')) {
      current.added.add(newLineCursor);
      newLineCursor += 1;
    } else if (current && line.startsWith('-') && !line.startsWith('---')) {
      // Removed lines occupy no new-side number; do not advance the cursor.
    } else if (current && !line.startsWith('\\')) {
      // Context lines (rare with --unified=0) advance the new-side cursor.
      newLineCursor += 1;
    }
  }
  push();
  return files;
}

// Vitest coverage `include` is `src/**/*.ts`. Test files are excluded there and
// carry no product logic, so they never count toward the gate or the excluded
// tally (which exists to surface hidden logic, not test code).
export function isTestFile(path: string): boolean {
  return /\.test\.ts$/.test(path) || /(^|\/)__tests__\//.test(path);
}

export function isIncludableSource(path: string): boolean {
  return /^src\/.*\.ts$/.test(path) && !isTestFile(path);
}

// A changed line looks like product code (not blank, not a comment-only line).
// Used only for the non-gating excluded tally, where no lcov signal exists.
function isCodeLike(text: string | undefined): boolean {
  if (text === undefined) return false;
  const trimmed = text.trim();
  if (trimmed === '') return false;
  if (trimmed.startsWith('//')) return false;
  if (trimmed.startsWith('/*') || trimmed.startsWith('*/') || trimmed.startsWith('*')) return false;
  return true;
}

// Lines suppressed by an explicit coverage-ignore directive (v8 / c8 / istanbul).
// `next [N]` ignores the following N lines (default 1); `start`/`stop` bracket a
// range. Matches how vitest's v8 provider drops these from the DA records.
export function ignoredLineSet(lines: readonly string[]): Set<number> {
  const ignored = new Set<number>();
  let rangeActive = false;
  const directive = /(?:v8|c8|istanbul)\s+ignore\s+(next|start|stop)(?:\s+(\d+))?/;
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const match = directive.exec(lines[i] ?? '');
    if (match) {
      const kind = match[1];
      if (kind === 'start') {
        rangeActive = true;
        ignored.add(lineNo);
      } else if (kind === 'stop') {
        rangeActive = false;
      } else if (kind === 'next') {
        const count = match[2] ? Number(match[2]) : 1;
        for (let k = 1; k <= count; k += 1) ignored.add(lineNo + k);
      }
      continue;
    }
    if (rangeActive) ignored.add(lineNo);
  }
  return ignored;
}

export type FileCoverageReport = {
  readonly path: string;
  readonly coveredLines: number;
  readonly totalLines: number;
  readonly uncoveredLines: readonly number[];
  readonly coveredBranches: number;
  readonly totalBranches: number;
};

export type ExcludedFileReport = {
  readonly path: string;
  readonly reason: 'excluded-path' | 'ignored-lines';
  readonly lines: readonly number[];
};

export type ChangedCoverageResult = {
  readonly threshold: number;
  readonly coveredLines: number;
  readonly totalLines: number;
  // null when no changed line is coverable (e.g. a docs-only PR): the gate is a
  // trivial pass rather than a divide-by-zero.
  readonly pct: number | null;
  readonly waived: boolean;
  readonly passed: boolean;
  readonly files: readonly FileCoverageReport[];
  readonly offenders: readonly FileCoverageReport[];
  readonly branch: {
    readonly covered: number;
    readonly total: number;
    readonly pct: number | null;
  };
  readonly excluded: { readonly files: readonly ExcludedFileReport[]; readonly totalLines: number };
};

function ratioPct(covered: number, total: number): number | null {
  if (total === 0) return null;
  return Math.round((covered / total) * 10000) / 100;
}

export type ComputeInput = {
  readonly diffs: readonly ChangedFileDiff[];
  readonly coverage: CoverageIndex;
  // New-side content of a changed file (working tree at HEAD), or null when the
  // path cannot be read. Only consulted for the non-gating excluded tally.
  readonly fileLines: (path: string) => readonly string[] | null;
  readonly waived?: boolean;
};

export function computeChangedCoverage(input: ComputeInput): ChangedCoverageResult {
  const files: FileCoverageReport[] = [];
  const excludedFiles: ExcludedFileReport[] = [];
  let coveredLines = 0;
  let totalLines = 0;
  let coveredBranches = 0;
  let totalBranches = 0;
  let excludedLineTotal = 0;

  for (const diff of input.diffs) {
    if (diff.deleted || diff.added.length === 0) continue;
    if (!isIncludableSource(diff.path)) continue;

    const cov = input.coverage.get(diff.path);
    const addedSet = new Set(diff.added);

    if (!cov) {
      // Includable source absent from the all-files lcov report: an exclude glob
      // dropped it. Count its code-like added lines so the exclusion is visible.
      const lines = input.fileLines(diff.path);
      const excludedLines = diff.added.filter((n) => isCodeLike(lines?.[n - 1]));
      if (excludedLines.length > 0) {
        excludedFiles.push({ path: diff.path, reason: 'excluded-path', lines: excludedLines });
        excludedLineTotal += excludedLines.length;
      }
      continue;
    }

    let covered = 0;
    let total = 0;
    const uncovered: number[] = [];
    for (const n of diff.added) {
      const hits = cov.lineHits.get(n);
      if (hits === undefined) continue;
      total += 1;
      if (hits > 0) covered += 1;
      else uncovered.push(n);
    }
    for (const branch of cov.branches) {
      if (!addedSet.has(branch.line)) continue;
      totalBranches += 1;
      if (branch.taken > 0) coveredBranches += 1;
    }

    // Changed lines suppressed by an ignore directive: executable-looking, not
    // in the DA records, inside an ignore range. Reported, never gated.
    const contentLines = input.fileLines(diff.path);
    if (contentLines) {
      const ignored = ignoredLineSet(contentLines);
      const ignoredChanged = diff.added.filter(
        (n) => ignored.has(n) && !cov.lineHits.has(n) && isCodeLike(contentLines[n - 1]),
      );
      if (ignoredChanged.length > 0) {
        excludedFiles.push({ path: diff.path, reason: 'ignored-lines', lines: ignoredChanged });
        excludedLineTotal += ignoredChanged.length;
      }
    }

    coveredLines += covered;
    totalLines += total;
    files.push({
      path: diff.path,
      coveredLines: covered,
      totalLines: total,
      uncoveredLines: uncovered,
      coveredBranches: cov.branches.filter((b) => addedSet.has(b.line) && b.taken > 0).length,
      totalBranches: cov.branches.filter((b) => addedSet.has(b.line)).length,
    });
  }

  const pct = ratioPct(coveredLines, totalLines);
  const waived = Boolean(input.waived);
  const meetsThreshold = pct === null || pct >= CHANGED_LINE_COVERAGE_THRESHOLD;
  const offenders = files
    .filter((file) => file.uncoveredLines.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    threshold: CHANGED_LINE_COVERAGE_THRESHOLD,
    coveredLines,
    totalLines,
    pct,
    waived,
    passed: waived || meetsThreshold,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    offenders,
    branch: {
      covered: coveredBranches,
      total: totalBranches,
      pct: ratioPct(coveredBranches, totalBranches),
    },
    excluded: {
      files: excludedFiles.sort((a, b) => a.path.localeCompare(b.path)),
      totalLines: excludedLineTotal,
    },
  };
}
