// Pure model for the changed-line coverage gate (#1418): joins a unified=0
// diff (base...HEAD) with vitest's lcov report to score coverage of CHANGED
// LINES ONLY. Only added (new-side) lines count — deleted lines never do — so
// the gate is deterministic against renames and deletes. run.ts owns all I/O.
//
// The coverable universe is the lcov report itself, not a second copy of
// vitest's exclude globs: coverage runs with `all` on, so every includable
// `src/**/*.ts` file appears in lcov even when untested. A changed includable
// file ABSENT from lcov was dropped by an exclude glob — reported (non-gating)
// so exclusions cannot silently absorb new logic.

// Single source of truth for the gate. Changed-line coverage below this
// percentage fails the Coverage CI job (unless waived).
export const CHANGED_LINE_COVERAGE_THRESHOLD = 70;

export type LcovBranch = { readonly line: number; readonly taken: number };

export type LcovFile = {
  readonly path: string;
  // line -> DA hit count; lines absent here are non-executable or ignored.
  readonly lineHits: ReadonlyMap<number, number>;
  readonly branches: readonly LcovBranch[];
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

function parseDaRecord(body: string): readonly [number, number] | null {
  const [lineNo, hits] = body.split(',');
  const n = Number(lineNo);
  const h = Number(hits);
  return Number.isFinite(n) && Number.isFinite(h) ? [n, h] : null;
}

function parseBrdaRecord(body: string): LcovBranch | null {
  // BRDA:<line>,<block>,<branch>,<taken>; taken is '-' when never reached.
  const parts = body.split(',');
  const line = Number(parts[0]);
  if (!Number.isFinite(line)) return null;
  const takenRaw = parts[3];
  const taken = takenRaw === '-' || takenRaw === undefined ? 0 : Number(takenRaw);
  return { line, taken: Number.isFinite(taken) ? taken : 0 };
}

function parseLcovRecord(block: string, rootDir?: string): LcovFile | null {
  let path: string | null = null;
  const lineHits = new Map<number, number>();
  const branches: LcovBranch[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      path = normalizePath(line.slice(3), rootDir);
    } else if (line.startsWith('DA:')) {
      const da = parseDaRecord(line.slice(3));
      if (da) lineHits.set(da[0], da[1]);
    } else if (line.startsWith('BRDA:')) {
      const branch = parseBrdaRecord(line.slice(5));
      if (branch) branches.push(branch);
    }
  }
  return path === null ? null : { path, lineHits, branches };
}

export function parseLcov(text: string, rootDir?: string): CoverageIndex {
  const index = new Map<string, LcovFile>();
  for (const block of text.split('end_of_record')) {
    const file = parseLcovRecord(block, rootDir);
    if (file) index.set(file.path, file);
  }
  return index;
}

type DiffSection = { path: string; added: Set<number>; deleted: boolean; cursor: number };

function newStartOfHunk(line: string): number | null {
  const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return match ? Number(match[1]) : null;
}

function pathFromDiffHeader(line: string): string {
  const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  return header ? normalizePath(header[1]!) : '';
}

// Fold one line of a file's diff body into its section. Renames+edits report
// their added lines under the destination (`+++ b/...`); pure renames and
// deletions add nothing. `--unified=0` means no context lines in practice.
function foldDiffBodyLine(section: DiffSection, line: string): void {
  if (line.startsWith('+++ ')) {
    const target = line.slice(4).trim();
    if (target === '/dev/null') section.deleted = true;
    else section.path = normalizePath(target);
  } else if (line.startsWith('@@')) {
    const start = newStartOfHunk(line);
    if (start !== null) section.cursor = start;
  } else if (line.startsWith('+') && !line.startsWith('+++')) {
    section.added.add(section.cursor);
    section.cursor += 1;
  } else if (line.startsWith('-') || line.startsWith('\\')) {
    // Removed line or "\ No newline": occupies no new-side number.
  } else {
    section.cursor += 1;
  }
}

export function parseUnifiedDiff(diff: string): ChangedFileDiff[] {
  const files: ChangedFileDiff[] = [];
  let section: DiffSection | null = null;
  const flush = (): void => {
    if (section && section.path) {
      files.push({
        path: section.path,
        added: [...section.added].sort((a, b) => a - b),
        deleted: section.deleted,
      });
    }
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      section = { path: pathFromDiffHeader(line), added: new Set(), deleted: false, cursor: 0 };
    } else if (section) {
      foldDiffBodyLine(section, line);
    }
  }
  flush();
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
  return !/^(\/\/|\/\*|\*)/.test(trimmed);
}

type IgnoreDirective = { readonly kind: 'next' | 'start' | 'stop'; readonly count: number };

function parseIgnoreDirective(line: string): IgnoreDirective | null {
  const match = /(?:v8|c8|istanbul)\s+ignore\s+(next|start|stop)(?:\s+(\d+))?/.exec(line);
  if (!match) return null;
  return { kind: match[1] as IgnoreDirective['kind'], count: match[2] ? Number(match[2]) : 1 };
}

// Lines suppressed by an explicit coverage-ignore directive (v8 / c8 / istanbul).
// `next [N]` ignores the following N lines (default 1); `start`/`stop` bracket a
// range. Matches how vitest's v8 provider drops these from the DA records.
export function ignoredLineSet(lines: readonly string[]): Set<number> {
  const ignored = new Set<number>();
  let rangeActive = false;
  for (let i = 0; i < lines.length; i += 1) {
    const directive = parseIgnoreDirective(lines[i] ?? '');
    if (directive === null) {
      if (rangeActive) ignored.add(i + 1);
    } else if (directive.kind === 'stop') {
      rangeActive = false;
    } else if (directive.kind === 'start') {
      rangeActive = true;
      ignored.add(i + 1);
    } else {
      for (let k = 1; k <= directive.count; k += 1) ignored.add(i + 1 + k);
    }
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

function scoreGateFile(path: string, added: readonly number[], cov: LcovFile): FileCoverageReport {
  let coveredLines = 0;
  let totalLines = 0;
  const uncoveredLines: number[] = [];
  for (const n of added) {
    const hits = cov.lineHits.get(n);
    if (hits === undefined) continue;
    totalLines += 1;
    if (hits > 0) coveredLines += 1;
    else uncoveredLines.push(n);
  }
  const addedSet = new Set(added);
  const changedBranches = cov.branches.filter((b) => addedSet.has(b.line));
  return {
    path,
    coveredLines,
    totalLines,
    uncoveredLines,
    coveredBranches: changedBranches.filter((b) => b.taken > 0).length,
    totalBranches: changedBranches.length,
  };
}

// Changed lines suppressed by an ignore directive: executable-looking, absent
// from the DA records, inside an ignore range. Reported, never gated.
function ignoredChangedLines(
  added: readonly number[],
  cov: LcovFile,
  contentLines: readonly string[],
): number[] {
  const ignored = ignoredLineSet(contentLines);
  return added.filter(
    (n) => ignored.has(n) && !cov.lineHits.has(n) && isCodeLike(contentLines[n - 1]),
  );
}

export type ComputeInput = {
  readonly diffs: readonly ChangedFileDiff[];
  readonly coverage: CoverageIndex;
  // New-side content of a changed file (working tree at HEAD), or null when the
  // path cannot be read. Only consulted for the non-gating excluded tally.
  readonly fileLines: (path: string) => readonly string[] | null;
  readonly waived?: boolean;
};

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0);
}

export function computeChangedCoverage(input: ComputeInput): ChangedCoverageResult {
  const files: FileCoverageReport[] = [];
  const excludedFiles: ExcludedFileReport[] = [];

  for (const diff of input.diffs) {
    if (diff.deleted || diff.added.length === 0 || !isIncludableSource(diff.path)) continue;

    const cov = input.coverage.get(diff.path);
    if (!cov) {
      // Includable source absent from the all-files lcov report: an exclude glob
      // dropped it. Count its code-like added lines so the exclusion is visible.
      const lines = input.fileLines(diff.path);
      const excluded = diff.added.filter((n) => isCodeLike(lines?.[n - 1]));
      if (excluded.length > 0) {
        excludedFiles.push({ path: diff.path, reason: 'excluded-path', lines: excluded });
      }
      continue;
    }

    files.push(scoreGateFile(diff.path, diff.added, cov));
    const contentLines = input.fileLines(diff.path);
    const ignored = contentLines ? ignoredChangedLines(diff.added, cov, contentLines) : [];
    if (ignored.length > 0) {
      excludedFiles.push({ path: diff.path, reason: 'ignored-lines', lines: ignored });
    }
  }

  const coveredLines = sum(files, (f) => f.coveredLines);
  const totalLines = sum(files, (f) => f.totalLines);
  const coveredBranches = sum(files, (f) => f.coveredBranches);
  const totalBranches = sum(files, (f) => f.totalBranches);
  const pct = ratioPct(coveredLines, totalLines);
  const waived = Boolean(input.waived);

  const byPath = (a: { path: string }, b: { path: string }): number => a.path.localeCompare(b.path);
  return {
    threshold: CHANGED_LINE_COVERAGE_THRESHOLD,
    coveredLines,
    totalLines,
    pct,
    waived,
    passed: waived || pct === null || pct >= CHANGED_LINE_COVERAGE_THRESHOLD,
    offenders: files.filter((f) => f.uncoveredLines.length > 0).sort(byPath),
    branch: {
      covered: coveredBranches,
      total: totalBranches,
      pct: ratioPct(coveredBranches, totalBranches),
    },
    excluded: {
      files: [...excludedFiles].sort(byPath),
      totalLines: sum(excludedFiles, (f) => f.lines.length),
    },
  };
}
