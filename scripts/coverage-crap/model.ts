// Pure pieces of the coverage-based CRAP verdict: which Istanbul file records fallow can trust,
// whether the two reports of one coverage run agree about what it measured, and how the scored
// functions are rendered. run.ts owns the git, fallow, config and file I/O.
import type { ChangedFileDiff } from '../lib/repo-git.ts';
import { repoRelativePath } from '../lib/repo-path.ts';

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
 * Two upstream defects produced those counts on real runs, both fixed by the patches under
 * `patches/`: the v8 provider resolved a module's script wrapper length from whichever coverage
 * file it read last, so an unmeasured one shifted every offset off its source, and
 * `ast-v8-to-istanbul` subtracted located branch paths from a region that did not contain them,
 * which an awaited continuation can make negative. Either can also merge into a record measured
 * correctly and pull its counts down, so a record is dropped whole rather than repaired; zeroed
 * counts from the same shift are indistinguishable from untested code and stay. A dropped file
 * gets no CRAP score rather than a wrong one.
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
 * The files whose lines this change edits. A pure rename, delete, or mode change adds no lines, so
 * it contributes none — which is also exactly the set of files fallow's `--diff-stdin` scoping can
 * charge a finding to, since that filter indexes the same added lines.
 */
export function readTouchedFiles(diffs: readonly ChangedFileDiff[]): TouchedFile[] {
  return diffs
    .filter((diff) => !diff.deleted && diff.added.length > 0)
    .map((diff) => ({ path: diff.path, addedLines: diff.added.length }));
}

/** A touched file the coverage run enumerated but recorded no counters for. */
export type UnscoredTouchedFile = Readonly<{ path: string; addedLines: number }>;

/**
 * Why this run cannot trust what it scored. Keyed, never inferred from error text: the report and
 * the remediation both branch on `kind`, and prose is the one place a reason could be reworded
 * away. A missing or unreadable map is not one of these — run.ts fails before computing a verdict,
 * because there is no report left to reason about.
 */
export type CrapProblem =
  | Readonly<{ kind: 'enumeration_missing' }>
  | Readonly<{ kind: 'map_partial'; mapFiles: number; enumeratedFiles: number }>
  | Readonly<{ kind: 'corrupt_touched'; files: readonly string[] }>
  | Readonly<{ kind: 'unscored_touched'; files: readonly UnscoredTouchedFile[] }>
  | Readonly<{ kind: 'unmeasured_touched'; files: readonly EstimatedFinding[] }>;

const PROBLEM_MESSAGES: Readonly<Record<CrapProblem['kind'], string>> = {
  enumeration_missing:
    'no usable lcov report lists the files the coverage run measured (coverage/lcov.info)',
  map_partial: 'the Istanbul coverage map records fewer files than the same run enumerated',
  corrupt_touched: 'touched file(s) were dropped from the map for impossible counts',
  unscored_touched: 'touched file(s) with changed lines have no record in the coverage map',
  unmeasured_touched:
    'touched function(s) are absent from the coverage map, so their score is estimated from complexity alone',
};

const PROBLEM_FIXES: Readonly<Record<CrapProblem['kind'], string>> = {
  enumeration_missing:
    'Run `pnpm test:coverage` again: it writes coverage/lcov.info beside the map.',
  map_partial: 'Run `pnpm test:coverage` again on this commit; coverage/ mixes reports.',
  corrupt_touched:
    'Run `pnpm test:coverage` again on this commit. If the counts stay impossible, that file is unscored, not clean.',
  unscored_touched:
    'Run `pnpm test:coverage` again on this commit. A file the run never loaded has no measured score.',
  unmeasured_touched:
    'Run `pnpm test:coverage` again: the map predates these functions, so only their complexity is known.',
};

function describeProblemFile(file: string | UnscoredTouchedFile | EstimatedFinding): string {
  if (typeof file === 'string') return `\`${file}\``;
  return 'addedLines' in file
    ? `\`${file.path}\` (${file.addedLines} changed line(s))`
    : `\`${file.path}:${file.line}\` ${file.name}`;
}

function renderProblems(problems: readonly CrapProblem[]): string[] {
  return problems.map((problem) => {
    const counts =
      'mapFiles' in problem
        ? ` (${problem.mapFiles} recorded, ${problem.enumeratedFiles} enumerated)`
        : '';
    const files =
      'files' in problem ? `: ${problem.files.map(describeProblemFile).join(', ')}` : '';
    return `- **${PROBLEM_MESSAGES[problem.kind]}**${counts}${files}\n  ${PROBLEM_FIXES[problem.kind]}`;
  });
}

export type CrapVerdict = Readonly<{
  blocking: boolean;
  problems: readonly CrapProblem[];
  /** Estimates the report cannot measure, listed for the reader without blocking on them. */
  unscoped: readonly EstimatedFinding[];
  offenders: readonly CrapFinding[];
}>;

/**
 * The verdict for one report. `touched` scope blocks on a function at or above the threshold and on
 * any reason the report cannot be trusted to answer, because `[]` from a partial map looks exactly
 * like a clean branch. `all` scope is the backlog report on `main`, which carries debt on purpose: it
 * lists what it could not verify without blocking on it. `enumeratedPaths` is null when the run wrote
 * no usable lcov report, which from here means nothing was recorded as measured.
 */
export function decideCrapVerdict(input: {
  scope: CrapScope;
  findings: readonly CrapFinding[];
  estimated: readonly EstimatedFinding[];
  touched: readonly TouchedFile[];
  dropped: ReadonlySet<string>;
  mapPaths: ReadonlySet<string>;
  enumeratedPaths: ReadonlySet<string> | null;
}): CrapVerdict {
  const { enumeratedPaths } = input;
  const problems: CrapProblem[] = [];
  const corrupt = input.touched
    .filter((file) => input.dropped.has(file.path))
    .map((file) => file.path);
  if (corrupt.length > 0) problems.push({ kind: 'corrupt_touched', files: corrupt });
  // The enumeration is what answers "what did this run measure", the question the per-file verdict
  // cannot do without. The whole-repo backlog is scored from the map alone, so an absent lcov says
  // nothing about it and must not be called incomplete.
  if (enumeratedPaths === null && input.scope === 'touched') {
    problems.push({ kind: 'enumeration_missing' });
  }

  // Both checks below read the enumeration, and without it enumeration_missing above is the whole
  // story. lcov and the Istanbul map are two reports of one coverage run, so every file the run
  // enumerated has to be recorded in the map. The test is per path rather than a count: a map of the
  // right size holding the wrong paths — one file measured, another dropped, both reported as 1,724
  // entries — is exactly what a report mixed from two coverage runs looks like, and counting would
  // trust it.
  if (enumeratedPaths !== null) {
    const unrecorded = new Set([...enumeratedPaths].filter((file) => !input.mapPaths.has(file)));
    if (unrecorded.size > 0) {
      problems.push({
        kind: 'map_partial',
        mapFiles: input.mapPaths.size,
        enumeratedFiles: enumeratedPaths.size,
      });
    }

    // Of those, the ones this diff touches are what the verdict was going to score. Records the
    // sanitizer dropped are named as corrupt above and stay in `mapPaths`, so they are not also here.
    const unscored = input.touched
      .filter((file) => unrecorded.has(file.path))
      .map((file) => ({ path: file.path, addedLines: file.addedLines }));
    if (unscored.length > 0) problems.push({ kind: 'unscored_touched', files: unscored });
  }

  // A touched file the map does record, with a function in it that the map does not: the map is
  // older than the code and fallow is estimating that function from its complexity.
  const touchedPaths = new Set(input.touched.map((file) => file.path));
  const unmeasured = input.estimated.filter(
    (finding) => touchedPaths.has(finding.path) && input.mapPaths.has(finding.path),
  );
  if (unmeasured.length > 0) problems.push({ kind: 'unmeasured_touched', files: unmeasured });

  // The same estimate for a file neither report knows is a different fact: coverage does not measure
  // that file at all (scripts, a package the coverage config excludes), so no re-run would score it and
  // it is not debt this PR owes. It is still not a measurement, so the report says so rather than let
  // the headline imply the function was checked and cleared. Files the run enumerated but did not
  // record are named as unscored above, and stay out of this list. Only while the enumeration exists:
  // without it, "coverage does not instrument this" is a claim this run cannot make.
  const unscoped = enumeratedPaths
    ? input.estimated.filter(
        (finding) =>
          touchedPaths.has(finding.path) &&
          !input.mapPaths.has(finding.path) &&
          !enumeratedPaths.has(finding.path),
      )
    : [];

  // In `touched` scope fallow has already narrowed the findings to functions whose lines the diff
  // adds, so nothing is left to re-filter here.
  return {
    blocking: input.scope === 'touched' && (input.findings.length > 0 || problems.length > 0),
    problems,
    unscoped,
    offenders: input.scope === 'touched' ? input.findings : [],
  };
}

/** A file-wide `maxCrap` override of `fallow-crap.json`, read from the resolved config. */
export type CrapExemption = Readonly<{ files: readonly string[]; maxCrap: number; reason: string }>;

/**
 * Resolved-config stdout as the file-wide CRAP exemptions: the overrides that raise `maxCrap` for
 * named files, so every function inside them is exempt — not only the out-of-process ones that
 * motivated the override. Which files those are is something the report states or admits it cannot
 * state, so failure is admitted too rather than thrown: a fallow that exits 0 and prints nothing
 * parseable must not turn the advisory `--all` run red.
 */
export function readCrapExemptions(stdout: string): CrapExemptions {
  try {
    const report = parseFallowJsonReport(stdout);
    const overrides =
      isRecord(report) && isRecord(report.health) ? report.health.thresholdOverrides : undefined;
    if (!Array.isArray(overrides)) return { available: true, exemptions: [] };
    return {
      available: true,
      exemptions: overrides
        .filter((override): override is Record<string, unknown> => isRecord(override))
        .filter((override) => typeof override.maxCrap === 'number' && override.maxCrap > 30)
        .map((override) => ({
          files: Array.isArray(override.files)
            ? override.files.filter((file): file is string => typeof file === 'string')
            : [],
          maxCrap: override.maxCrap as number,
          reason: typeof override.reason === 'string' ? override.reason : '',
        })),
    };
  } catch (error: unknown) {
    return {
      available: false,
      detail: error instanceof Error ? error.message.split('\n')[0]! : String(error),
    };
  }
}

/** The exemptions, or how they failed to load — "none" and "unknown" are different claims. */
export type CrapExemptions =
  | Readonly<{ available: true; exemptions: readonly CrapExemption[] }>
  | Readonly<{ available: false; detail: string }>;

export function renderCrapReport(input: {
  findings: readonly CrapFinding[];
  dropped: readonly string[];
  threshold: number;
  scope: CrapScope;
  verdict: CrapVerdict;
  exemptions?: CrapExemptions;
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
    ...renderUnscopedSection(verdict.unscoped),
    ...renderDroppedSection(dropped),
    ...renderExemptionSection(input.exemptions),
  ].join('\n')}\n`;
}

/**
 * Estimates the coverage run could not measure because the file is outside what it instruments. Not a
 * problem — a re-run changes nothing — but not a measurement either, and a bare "no touched
 * function(s)" headline would imply the reader was checked.
 */
function renderUnscopedSection(unscoped: readonly EstimatedFinding[]): readonly string[] {
  if (unscoped.length === 0) return [];
  return section([
    `Not measured, and not blocking: ${unscoped.length} touched function(s) in file(s) coverage does not instrument, scored from complexity alone: ${unscoped
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
      `(for example, an unresolved script wrapper offset or a negative branch path count, ` +
      `both fixed under patches/): ${dropped.map((file) => `\`${file}\``).join(', ')}`,
  ]);
}

function renderExemptionSection(exemptions: CrapExemptions | undefined): readonly string[] {
  if (!exemptions) return [];
  if (!exemptions.available) {
    return section([
      `File-wide CRAP exemptions could not be read from the config (${exemptions.detail}), so this report cannot say which files are exempt.`,
    ]);
  }
  return section([
    `File-wide CRAP exemptions in \`fallow-crap.json\` (${exemptions.exemptions.length}). Each exempts every function in its files, including helpers Node could test:`,
    ...exemptions.exemptions.map(
      (exemption) =>
        `- ${exemption.files.map((file) => `\`${file}\``).join(', ')} — \`maxCrap: ${exemption.maxCrap.toExponential(0)}\`${exemption.reason ? `: ${exemption.reason}` : ''}`,
    ),
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
