// Pure pieces of the coverage-based CRAP verdict: which Istanbul file records fallow can trust, which
// touched files the coverage run was told to instrument, and how the scored functions are rendered.
// run.ts owns the git, stamp, fallow and file I/O.
import type { ChangedFileDiff } from '../lib/repo-git.ts';
import { repoRelativePath } from '../lib/repo-path.ts';
import { isInstrumentedPath, type CoverageConfig } from './stamp.ts';

type IstanbulCounters = Readonly<{
  s?: Readonly<Record<string, unknown>>;
  f?: Readonly<Record<string, unknown>>;
  b?: Readonly<Record<string, unknown>>;
}>;

export type IstanbulCoverageMap = Readonly<Record<string, IstanbulCounters>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The Istanbul map `pnpm test:coverage` writes, or a failure naming what is wrong with it.
 *
 * A PR gate decides from this file, so an unreadable one has to be its own outcome rather than an
 * empty findings list: `[]` and `{}` both read as "nothing here is complex enough to block".
 */
export function parseIstanbulCoverageMap(text: string): IstanbulCoverageMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(
      `coverage map is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `coverage map is ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not a file -> counters object`,
    );
  }
  for (const [file, record] of Object.entries(parsed)) {
    if (!isRecord(record)) {
      throw new Error(`coverage map record for ${file} is ${typeof record}, not a counters object`);
    }
    for (const counter of ['s', 'f', 'b'] as const) {
      const counts = record[counter];
      if (counts !== undefined && !isRecord(counts)) {
        throw new Error(
          `coverage map record for ${file} has ${counter} as ${typeof counts}, not a count object`,
        );
      }
    }
  }
  return parsed as IstanbulCoverageMap;
}

/**
 * A coverage map's keys as repo-relative paths. Vitest writes absolute ones, so the record's home
 * is part of reading the map: a report from another checkout relativizes outside this root and
 * matches none of its files, which must not read as "that file was never measured".
 */
export function coverageMapPaths(map: IstanbulCoverageMap, root: string): Set<string> {
  return new Set(Object.keys(map).map((key) => repoRelativePath(key, root)));
}

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
 * Drops file records with a negative, null, or non-integer hit count, which fallow refuses the
 * whole map over.
 *
 * The one defect that produced those counts on real runs is patched under `patches/`:
 * `ast-v8-to-istanbul` subtracts located branch paths from a region that did not contain them,
 * which an awaited continuation can make negative. Vitest 5 fixed the other upstream (#10506,
 * #10643): the v8 provider used to resolve a module's script wrapper length from whichever coverage
 * file it read last, so an unmeasured one shifted every offset off its source. Either defect's
 * counts could also merge into a record measured correctly and pull them down, so a record is
 * dropped whole rather than repaired; zeroed counts from the same shift are indistinguishable from
 * untested code and stay. A dropped file gets no CRAP score rather than a wrong one.
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
  if (!isRecord(value)) return null;
  const { path, name, line, crap, cyclomatic } = value;
  // Outside the coverage map (tests, scripts, dropped records) fallow estimates from imports.
  if (value.coverage_source !== 'istanbul') return null;
  if (typeof path !== 'string' || typeof name !== 'string') return null;
  if (typeof line !== 'number' || typeof crap !== 'number' || typeof cyclomatic !== 'number') {
    return null;
  }
  const coveragePct = typeof value.coverage_pct === 'number' ? value.coverage_pct : null;
  return { path, name, line, crap, cyclomatic, coveragePct };
}

/** The JSON report from fallow's stdout, past any line it prints before the report. */
export function parseFallowJsonReport(stdout: string): unknown {
  const start = stdout.indexOf('{');
  if (start === -1) throw new Error(`fallow printed no JSON report:\n${stdout.slice(0, 2000)}`);
  return JSON.parse(stdout.slice(start));
}

function readFindings(report: unknown): readonly Record<string, unknown>[] {
  const findings = isRecord(report) ? report.findings : undefined;
  if (!Array.isArray(findings)) throw new Error('fallow health report has no findings array');
  return findings.filter((entry): entry is Record<string, unknown> => isRecord(entry));
}

/** The measured CRAP findings of one `fallow health --format json` report, highest score first. */
export function readCrapFindings(report: unknown, threshold: number): CrapFinding[] {
  return readFindings(report)
    .map(readFinding)
    .filter((finding): finding is CrapFinding => finding !== null && finding.crap >= threshold)
    .sort((left, right) => right.crap - left.crap || left.path.localeCompare(right.path));
}

/** A function at or above the threshold that fallow scored without an Istanbul record. */
export type EstimatedFinding = Readonly<{
  path: string;
  name: string;
  line: number;
  crap: number;
}>;

/**
 * The functions reported at or above the threshold that fallow scored from complexity alone: it
 * emits `coverage_source: 'estimated'` when a function's definition is not in the coverage data, so
 * in a file the map *does* record the map predates the function. Such a score is not a measurement,
 * and cannot settle whether a touched function is affordable.
 */
export function readEstimatedFindings(report: unknown, threshold: number): EstimatedFinding[] {
  return readFindings(report)
    .filter((entry) => entry.coverage_source !== 'istanbul')
    .filter((entry) => typeof entry.crap === 'number' && entry.crap >= threshold)
    .filter((entry) => typeof entry.path === 'string' && typeof entry.name === 'string')
    .map((entry) => ({
      path: entry.path as string,
      name: entry.name as string,
      line: typeof entry.line === 'number' ? entry.line : 0,
      crap: entry.crap as number,
    }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

function formatCoverage(pct: number | null): string {
  return pct === null ? 'n/a' : `${pct.toFixed(0)}%`;
}

/** `touched` scores the functions a diff changes; `all` scores every function in the map. */
export type CrapScope = 'touched' | 'all';

/** A source file the diff adds lines to, and how many. */
export type TouchedFile = Readonly<{ path: string; addedLines: number }>;

/**
 * The files whose lines this change edits. A pure rename, delete, mode change, or non-blob side
 * (a symlink or a gitlink) adds no scoreable source, so it contributes none — which is also exactly
 * the set of files fallow's `--diff-stdin` scoping can charge a finding to, since that filter indexes
 * the same added lines. Dropping non-blob sides here is also what keeps every `TouchedFile` a path
 * the working tree can be asked to hold as a readable file.
 */
export function readTouchedFiles(diffs: readonly ChangedFileDiff[]): TouchedFile[] {
  return diffs
    .filter((diff) => !diff.deleted && diff.regularFile && diff.added.length > 0)
    .map((diff) => ({ path: diff.path, addedLines: diff.added.length }));
}

/**
 * Why this run cannot trust what it scored. Keyed, never inferred from error text: the report and the
 * remediation both branch on `kind`, and prose is the one place a reason could be reworded away. A
 * stamp that does not match this checkout is not one of these — run.ts refuses before asking fallow,
 * because then there is no report left to reason about.
 */
export type CrapProblem =
  | Readonly<{ kind: 'corrupt_touched'; files: readonly string[] }>
  | Readonly<{ kind: 'unrecorded_eligible'; files: readonly TouchedFile[] }>;

const PROBLEM_MESSAGES: Readonly<Record<CrapProblem['kind'], string>> = {
  corrupt_touched: 'touched file(s) were dropped from the map for impossible counts',
  unrecorded_eligible:
    'touched file(s) the coverage config instruments have no record in the coverage map',
};

const PROBLEM_FIXES: Readonly<Record<CrapProblem['kind'], string>> = {
  corrupt_touched:
    'Run `pnpm test:coverage` again on this commit. If the counts stay impossible, that file is unscored, not clean.',
  unrecorded_eligible:
    'Run `pnpm test:coverage` again on this commit. If the file still has no record, nothing this run ' +
    "executes loads it — the config's `exclude` or a whole-file ignore comment is how it declares " +
    'itself out of scope.',
};

function describeProblemFile(file: string | TouchedFile): string {
  return typeof file === 'string'
    ? `\`${file}\``
    : `\`${file.path}\` (${file.addedLines} changed line(s))`;
}

function renderProblems(problems: readonly CrapProblem[]): string[] {
  return problems.map(
    (problem) =>
      `- **${PROBLEM_MESSAGES[problem.kind]}**: ${problem.files
        .map(describeProblemFile)
        .join(', ')}\n  ${PROBLEM_FIXES[problem.kind]}`,
  );
}

export type CrapVerdict = Readonly<{
  blocking: boolean;
  problems: readonly CrapProblem[];
  /** Estimates no run will measure: the config excludes the file, or an ignore comment drops it. */
  uninstrumented: readonly EstimatedFinding[];
  offenders: readonly CrapFinding[];
}>;

/**
 * The verdict for one report. `touched` blocks on a function at or above the threshold and on any
 * reason the report cannot answer, because `[]` from a partial map looks exactly like a clean branch.
 * `all` is the backlog report on `main`, which carries debt on purpose: it exits 0 once it has a
 * report to show, so it answers none of the touched-file questions — that list is what they are asked
 * over, and `all` runs without one.
 */
export function decideCrapVerdict(input: {
  scope: CrapScope;
  findings: readonly CrapFinding[];
  estimated: readonly EstimatedFinding[];
  touched: readonly TouchedFile[];
  dropped: ReadonlySet<string>;
  /** Files the surviving map records. A record the sanitizer dropped is corrupt, not missing. */
  mapPaths: ReadonlySet<string>;
  /** The config the verified stamp declared, or null when no stamp was required of this run. */
  coverage: CoverageConfig | null;
  /** Touched files whose source carries a whole-file ignore comment, which no run records. */
  ignoredFiles: ReadonlySet<string>;
}): CrapVerdict {
  const { coverage, ignoredFiles } = input;
  const problems: CrapProblem[] = [];
  const corrupt = input.touched
    .filter((file) => input.dropped.has(file.path))
    .map((file) => file.path);
  if (corrupt.length > 0) problems.push({ kind: 'corrupt_touched', files: corrupt });

  // Eligibility is a declaration, never an absence: the config the run resolved to names the files it
  // was told to instrument, so a touched one of those the map does not record is a gap this change
  // owes a re-run for, while a file the config excludes is out of scope. `mapPaths` holds the records
  // including the corrupt ones, so a file named above is never missing from the map as well.
  const unrecorded = coverage
    ? input.touched.filter(
        (file) =>
          !input.mapPaths.has(file.path) &&
          !ignoredFiles.has(file.path) &&
          isInstrumentedPath(file.path, coverage),
      )
    : [];
  if (unrecorded.length > 0) problems.push({ kind: 'unrecorded_eligible', files: unrecorded });

  // Estimates on a touched file that is not a gap above. The stamp proves the map describes this
  // tree, so a function it does not record cannot predate the map: an ignore comment discarded its
  // lines, or it runs where the inspector never sees it — a worker, a page-evaluated script, a child
  // process. Listing them keeps a green run from reading as "checked and cleared" without sending the
  // reader to re-run coverage for something a re-run cannot change. A file already named above owes no
  // second mention, and a run that read no config declares no scope, so it claims none.
  const named = new Set([...corrupt, ...unrecorded.map((file) => file.path)]);
  const touchedPaths = new Set(input.touched.map((file) => file.path));
  const uninstrumented = coverage
    ? input.estimated.filter(
        (finding) => touchedPaths.has(finding.path) && !named.has(finding.path),
      )
    : [];

  // In `touched` scope fallow has already narrowed the findings to functions whose lines the diff
  // adds, so nothing is left to re-filter here.
  return {
    blocking: input.scope === 'touched' && (input.findings.length > 0 || problems.length > 0),
    problems,
    uninstrumented,
    offenders: input.scope === 'touched' ? input.findings : [],
  };
}

/** A configured CRAP ceiling and the function this run applied it to. */
export type CrapOverride = Readonly<{
  file: string;
  name: string;
  maxCrap: number;
  reason: string;
  /** The function scored at or above its ceiling, so the exemption no longer covers it. */
  exceeded: boolean;
}>;

/** A CRAP ceiling no longer doing anything: the function no longer needs it or no longer exists. */
export type CrapStaleOverride = Readonly<{
  file: string | null;
  name: string | null;
  reason: string;
}>;

/**
 * The `health.thresholdOverrides` ceilings this run applied, read from the same health report as
 * the findings. fallow echoes each override with the function it matched: `active`, or
 * `insufficient` when the function scored above the ceiling, while `stale` and `no_match` mean the
 * ceiling is no longer needed or matches nothing and can go. The `no_match` row appears only in a
 * full run, so naming deleted overrides is a `--all` report signal; the report never reads the
 * config a second time.
 */
export type CrapOverrides = Readonly<{
  matched: readonly CrapOverride[];
  stale: readonly CrapStaleOverride[];
}>;

/** One echoed override, or null when it is not a CRAP ceiling applied to a named function. */
function readMatchedOverride(entry: Record<string, unknown>): CrapOverride | null {
  if (entry.dimension !== 'crap') return null;
  if (entry.status !== 'active' && entry.status !== 'insufficient') return null;
  if (typeof entry.path !== 'string' || typeof entry.function !== 'string') return null;
  // This entry's own ceiling: effective_thresholds is the merged result, which an overlapping
  // entry could have set.
  const configured = isRecord(entry.configured_thresholds) ? entry.configured_thresholds : {};
  if (typeof configured.max_crap !== 'number') return null;
  return {
    file: entry.path,
    name: entry.function,
    maxCrap: configured.max_crap,
    reason: typeof entry.reason === 'string' ? entry.reason : '',
    exceeded: entry.status === 'insufficient',
  };
}

function readStaleOverride(entry: Record<string, unknown>): CrapStaleOverride {
  return {
    file: typeof entry.path === 'string' ? entry.path : null,
    name: typeof entry.function === 'string' ? entry.function : null,
    reason: typeof entry.reason === 'string' ? entry.reason : '',
  };
}

export function readCrapOverrides(report: unknown): CrapOverrides {
  const entries =
    isRecord(report) && Array.isArray(report.threshold_overrides)
      ? report.threshold_overrides.filter((entry): entry is Record<string, unknown> =>
          isRecord(entry),
        )
      : [];
  const crap = entries.filter((entry) => entry.dimension === 'crap');
  const stale = crap
    .filter((entry) => entry.status === 'stale' || entry.status === 'no_match')
    .map(readStaleOverride);
  const matched = crap
    .map(readMatchedOverride)
    .filter((override): override is CrapOverride => override !== null);
  return { matched, stale };
}

export function renderCrapReport(input: {
  findings: readonly CrapFinding[];
  dropped: readonly string[];
  threshold: number;
  scope: CrapScope;
  verdict: CrapVerdict;
  overrides: CrapOverrides;
}): string {
  const { findings, dropped, threshold, scope, verdict } = input;
  // A PR fails for two different reasons and the reader must not confuse them: debt a touched
  // function owes, and a report that cannot answer. Only the second hides the count.
  const unanswerable = scope === 'touched' && verdict.problems.length > 0;
  const mode = scope === 'touched' ? `blocking at ${threshold}` : 'report-only';
  const headline = unanswerable
    ? 'no trustworthy verdict'
    : `${findings.length === 0 ? 'no' : findings.length} ${scope === 'touched' ? 'touched function(s)' : 'function(s)'} at or above ${threshold}`;
  return `${[
    `## Coverage-based CRAP (${mode}): ${headline}`,
    ...renderProblemSection(verdict.problems, unanswerable),
    ...renderFindingSection(findings),
    ...renderUninstrumentedSection(verdict.uninstrumented),
    ...renderDroppedSection(dropped),
    ...renderOverrideSection(input.overrides),
  ].join('\n')}\n`;
}

/**
 * Estimates from functions no coverage run will measure: the config excludes their file, an ignore
 * comment drops it or the lines around them, or the code executes somewhere the inspector never sees.
 * Not a problem — a re-run changes nothing — but not a measurement either, and a bare "no touched
 * function(s)" headline would imply the reader was checked and cleared.
 */
function renderUninstrumentedSection(
  uninstrumented: readonly EstimatedFinding[],
): readonly string[] {
  if (uninstrumented.length === 0) return [];
  return section([
    `Not measured, and not blocking: ${uninstrumented.length} touched function(s) no coverage run measures, scored from complexity alone: ${uninstrumented
      .map(
        (finding) =>
          `\`${finding.path}:${finding.line}\` ${finding.name} (CRAP ${finding.crap.toFixed(1)})`,
      )
      .join(', ')}`,
  ]);
}

/** A section of the report, or nothing. Each owns the blank line that separates it above. */
function section(content: readonly string[]): readonly string[] {
  return content.length === 0 ? [] : ['', ...content];
}

function renderProblemSection(problems: readonly CrapProblem[], unanswerable: boolean) {
  if (problems.length === 0) return [];
  return section([
    ...(unanswerable
      ? ['The reports this verdict would rest on do not answer the question:', '']
      : ['Not gating, but the report is incomplete:', '']),
    ...renderProblems(problems),
  ]);
}

function renderFindingSection(findings: readonly CrapFinding[]): readonly string[] {
  if (findings.length === 0) return [];
  return section([
    '| Function | CRAP | Cyclomatic | Coverage |',
    '| --- | ---: | ---: | ---: |',
    ...findings.map(
      (finding) =>
        `| \`${finding.path}:${finding.line}\` ${finding.name} | ${finding.crap.toFixed(1)} | ${finding.cyclomatic} | ${formatCoverage(finding.coveragePct)} |`,
    ),
    '',
    'Add tests for the uncovered branches, or split the function. Code that only runs out of process (workers, browser-evaluated scripts, child processes) measures 0%.',
  ]);
}

function renderDroppedSection(dropped: readonly string[]): readonly string[] {
  if (dropped.length === 0) return [];
  return section([
    `Unscored: ${dropped.length} file(s) with counts no execution can produce ` +
      `(for example, an implicit-else branch path count driven negative by an awaited ` +
      `continuation, which \`ast-v8-to-istanbul\` is patched against): ` +
      `${dropped.map((file) => `\`${file}\``).join(', ')}`,
  ]);
}

/**
 * The per-function CRAP exemptions the config declared and what this run did with them: the
 * ceiling each one carries, and any override whose ceiling no longer does anything — the debt
 * that file-wide `maxCrap: 1e12` exemptions let accumulate unseen.
 */
function renderOverrideSection(overrides: CrapOverrides): readonly string[] {
  if (overrides.matched.length === 0 && overrides.stale.length === 0) return [];
  return section([
    `CRAP exemptions from \`.fallowrc.json\` (${overrides.matched.length} applied). Each raises the ceiling for one function only, so growth above it still blocks:`,
    ...overrides.matched.map(
      (override) =>
        `- \`${override.file}\` \`${override.name}\` — ceiling ${override.maxCrap}${override.exceeded ? ' **(exceeded: scored above the ceiling)**' : ''}${override.reason ? `: ${override.reason}` : ''}`,
    ),
    ...(overrides.stale.length > 0
      ? [
          `No longer needed by any function and can be deleted: ${overrides.stale
            .map(
              (stale) =>
                `${stale.file === null ? 'an override' : `\`${stale.file}\`${stale.name === null ? '' : ` \`${stale.name}\``}`}${stale.reason === '' ? '' : ` (“${stale.reason}”)`}`,
            )
            .join(', ')}`,
        ]
      : []),
  ]);
}

// Workflow-command escaping (actions/toolkit `command.ts`): data may not carry `%`, CR, or LF, and
// a property additionally may not carry `:` or `,`, or a path or name could end the command early.
function escapeCommandData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeCommandProperty(value: string): string {
  return escapeCommandData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/** GitHub Actions warning annotations, one per finding, so the score shows on the diff. */
export function renderCrapAnnotations(findings: readonly CrapFinding[]): string {
  return findings
    .map((finding) => {
      const properties = [
        `file=${escapeCommandProperty(finding.path)}`,
        `line=${finding.line}`,
        `title=${escapeCommandProperty(`CRAP ${finding.crap.toFixed(1)}`)}`,
      ].join(',');
      const message = `${finding.name} has cyclomatic ${finding.cyclomatic} at ${formatCoverage(finding.coveragePct)} coverage.`;
      return `::warning ${properties}::${escapeCommandData(message)}\n`;
    })
    .join('');
}
