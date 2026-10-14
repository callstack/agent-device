import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  coverageMapPaths,
  decideCrapVerdict,
  parseFallowJsonReport,
  parseIstanbulCoverageMap,
  readCrapFindings,
  readCrapOverrides,
  renderCrapAnnotations,
  renderCrapReport,
  sanitizeIstanbulCoverage,
  type CrapFinding,
  type CrapProblem,
  type CrapScope,
  type CrapVerdict,
  type EstimatedFinding,
} from './model.ts';

const valid = { s: { 0: 3, 1: 0 }, f: { 0: 1 }, b: { 0: [2, 0] } };

test('sanitize keeps records whose counts are all non-negative integers', () => {
  const { map, dropped } = sanitizeIstanbulCoverage({ '/repo/a.ts': valid });
  assert.deepEqual(map, { '/repo/a.ts': valid });
  assert.deepEqual(dropped, []);
});

test('sanitize drops a record with any impossible statement, function, or branch count', () => {
  const { map, dropped } = sanitizeIstanbulCoverage({
    '/repo/ok.ts': valid,
    '/repo/negative-branch.ts': { ...valid, b: { 0: [1237, -1237] } },
    '/repo/negative-statement.ts': { ...valid, s: { 0: -1 } },
    '/repo/fractional-function.ts': { ...valid, f: { 0: 0.5 } },
    '/repo/missing-count.ts': { ...valid, s: { 0: null } },
  });
  assert.deepEqual(Object.keys(map), ['/repo/ok.ts']);
  assert.deepEqual(dropped, [
    '/repo/fractional-function.ts',
    '/repo/missing-count.ts',
    '/repo/negative-branch.ts',
    '/repo/negative-statement.ts',
  ]);
});

const finding = (overrides: Record<string, unknown>) => ({
  path: 'src/a.ts',
  name: 'run',
  line: 10,
  crap: 42,
  cyclomatic: 6,
  coverage_pct: 20,
  coverage_source: 'istanbul',
  ...overrides,
});

test('findings keep measured scores at or above the threshold, highest first', () => {
  const findings = readCrapFindings(
    {
      findings: [
        finding({ name: 'low', crap: 29.9 }),
        finding({ name: 'edge', crap: 30 }),
        finding({ name: 'high', crap: 90, coverage_pct: undefined }),
        finding({ name: 'estimated', crap: 95, coverage_source: 'estimated' }),
        { path: 'src/b.ts', name: 'no-score', line: 1, cyclomatic: 12 },
      ],
    },
    30,
  );
  assert.deepEqual(
    findings.map((entry) => [entry.name, entry.crap, entry.coveragePct]),
    [
      ['high', 90, null],
      ['edge', 30, 20],
    ],
  );
});

test('a report without a findings array is an error, not an empty verdict', () => {
  assert.throws(() => readCrapFindings({ error: true }, 30), /no findings array/);
});

/** A verdict that owes nothing: what `decideCrapVerdict` returns when the reports answer cleanly. */
const clean = (scope: CrapScope, findings: readonly CrapFinding[] = []): CrapVerdict => ({
  blocking: false,
  problems: [],
  unscoped: [],
  offenders: scope === 'touched' ? findings : [],
});

/** A report in the shape a case does not care about, so each case states only its difference. */
const render = (input: Partial<Parameters<typeof renderCrapReport>[0]> = {}) =>
  renderCrapReport({
    findings: [],
    dropped: [],
    threshold: 30,
    scope: 'touched',
    verdict: clean('touched'),
    overrides: { matched: [], stale: [] },
    ...input,
  });

/** A verdict that blocks or lists problems, for the renderer cases that build one by hand. */
const verdictWith = (
  problems: readonly CrapProblem[],
  unscoped: readonly EstimatedFinding[] = [],
) => ({
  blocking: true,
  problems,
  unscoped,
  offenders: [],
});

test('the report names touched functions and unscored files', () => {
  const findings = readCrapFindings({ findings: [finding({})] }, 30);
  const report = render({
    findings,
    dropped: ['src/odd.ts'],
    verdict: { blocking: true, problems: [], unscoped: [], offenders: findings },
  });
  assert.match(report, /1 touched function\(s\) at or above 30/);
  assert.match(report, /\| `src\/a\.ts:10` run \| 42\.0 \| 6 \| 20% \|/);
  assert.match(report, /Unscored: 1 file\(s\).*`src\/odd\.ts`/);
  // The known upstream causes are examples, not the whole rule: any negative, null, or fractional
  // count is dropped, and naming only the two would misdiagnose a new one.
  assert.match(report, /Unscored: 1 file\(s\).*for example/);
});

test('an empty report says none and lists no table', () => {
  const report = render();
  assert.match(report, /: no touched function/);
  assert.doesNotMatch(report, /\| Function/);
  // Each section owns its own emptiness guard, so a clean run must not announce empty ones: an
  // "Unscored: 0 file(s)" or "exemptions (0)" line reads as a finding to someone scanning the log.
  assert.doesNotMatch(report, /Unscored:/);
  assert.doesNotMatch(report, /exemptions/i);
});

test('a whole-repository report does not claim the functions were touched', () => {
  const findings = readCrapFindings({ findings: [finding({})] }, 30);
  const report = render({
    findings,
    scope: 'all',
    verdict: clean('all'),
  });
  assert.match(report, /: 1 function\(s\) at or above 30/);
});

test('a touched report whose reports cannot answer names the reason and stays ahead of the table', () => {
  const report = render({
    verdict: verdictWith([
      { kind: 'unscored_touched', files: [{ path: 'src/new.ts', addedLines: 4 }] },
      { kind: 'corrupt_touched', files: ['src/odd.ts'] },
    ]),
  });
  assert.match(report, /no trustworthy verdict/);
  assert.match(report, /no record in the coverage map\*\*: `src\/new\.ts` \(4 changed line\(s\)\)/);
  assert.match(report, /impossible counts\*\*: `src\/odd\.ts`/);
  // Every problem carries the command that clears it, since the reader has no other way to act.
  assert.match(report, /Run `pnpm test:coverage` again/);
});

test('an unanswerable touched report never reads as the empty verdict it was computed from', () => {
  const report = render({
    verdict: verdictWith([{ kind: 'enumeration_missing' }]),
  });
  assert.doesNotMatch(report, /no touched function\(s\)/);
  assert.match(report, /\*\*no usable lcov report lists the files the coverage run measured/);
});

test('the same gap in the whole-repo report is a note, not a verdict', () => {
  const report = render({
    scope: 'all',
    verdict: {
      ...verdictWith([{ kind: 'map_partial', mapFiles: 9, enumeratedFiles: 12 }]),
      blocking: false,
    },
  });
  assert.match(report, /report-only\): no function\(s\) at or above 30/);
  assert.match(report, /Not gating, but the report is incomplete/);
  assert.match(report, /\(9 recorded, 12 enumerated\)/);
});

// The same shape fallow echoes in its health JSON for one health run: each configured override
// with the function this run matched it to. `insufficient` is the growth case: the function scored
// above its ceiling. `stale` and `no_match` mean the ceiling is no longer doing anything — the
// function no longer needs it, or no longer exists.
const HEALTH_REPORT = {
  threshold_overrides: [
    {
      status: 'active',
      dimension: 'crap',
      path: 'src/worker.ts',
      function: 'runJob',
      configured_thresholds: { max_crap: 90 },
      // The merged ceiling differs (an overlapping entry set it lower), so a report that read the
      // merge instead of this entry's own config would print the wrong number.
      effective_thresholds: { max_cyclomatic: 20, max_cognitive: 15, max_crap: 45 },
      reason: 'Worker thread.',
    },
    {
      status: 'insufficient',
      dimension: 'crap',
      path: 'src/probe.ts',
      function: 'probePage',
      configured_thresholds: { max_crap: 90 },
      effective_thresholds: { max_crap: 90 },
      reason: 'Browser-evaluated.',
    },
    {
      status: 'stale',
      dimension: 'crap',
      path: 'src/fixed.ts',
      function: 'nowCovered',
      effective_thresholds: { max_crap: 90 },
      reason: 'Was untestable.',
    },
    {
      status: 'no_match',
      dimension: 'crap',
      configured_thresholds: { max_crap: 90 },
      reason: 'Moved away.',
    },
    {
      // A unit-size override is a different dimension and none of this report's business.
      status: 'active',
      dimension: 'unit_size',
      path: 'src/big.ts',
      function: 'bigThing',
      effective_thresholds: { max_unit_size: 200 },
      reason: 'Generated.',
    },
  ],
  findings: [],
};

test('the exemptions are read from the health report with the ceiling each one carries', () => {
  const overrides = readCrapOverrides(HEALTH_REPORT);
  assert.deepEqual(overrides.matched, [
    {
      file: 'src/worker.ts',
      name: 'runJob',
      maxCrap: 90,
      reason: 'Worker thread.',
      exceeded: false,
    },
    {
      file: 'src/probe.ts',
      name: 'probePage',
      maxCrap: 90,
      reason: 'Browser-evaluated.',
      exceeded: true,
    },
  ]);
  assert.deepEqual(overrides.stale, [
    { file: 'src/fixed.ts', name: 'nowCovered', reason: 'Was untestable.' },
    { file: null, name: null, reason: 'Moved away.' },
  ]);
  const report = render({ scope: 'all', verdict: clean('all'), overrides });
  assert.match(
    report,
    /CRAP exemptions from `\.fallowrc\.json` \(2 applied\).*one function only, so growth above it still blocks/s,
  );
  assert.match(report, /- `src\/worker\.ts` `runJob` — ceiling 90: Worker thread\./);
  assert.match(
    report,
    /`src\/probe\.ts` `probePage` — ceiling 90 \*\*\(exceeded: scored above the ceiling\)\*\*/,
  );
  assert.match(
    report,
    /No longer needed by any function and can be deleted: `src\/fixed\.ts` `nowCovered` \(“Was untestable\.”\), an override \(“Moved away\.”\)/,
  );
  assert.doesNotMatch(report, /`src\/big\.ts`/);
});

test('a report with no overrides section lists neither exemptions nor a gap', () => {
  // An absent `threshold_overrides` is not "all stale" and not a crash: an advisory `--all` run
  // must stay green when fallow echoes nothing.
  assert.deepEqual(readCrapOverrides({ findings: [] }), { matched: [], stale: [] });
  assert.deepEqual(readCrapOverrides('not json'), { matched: [], stale: [] });
  const report = render({ scope: 'all', verdict: clean('all'), overrides: readCrapOverrides({}) });
  assert.doesNotMatch(report, /exemptions/i);
});

/**
 * A verdict over one touched file in one measured file, with whatever a case cares about overridden.
 * The defaults are the shape of a clean answer, so each case states only its difference.
 */
const decide = (input: Partial<Parameters<typeof decideCrapVerdict>[0]> = {}) =>
  decideCrapVerdict({
    scope: 'touched',
    findings: [],
    estimated: [],
    touched: [{ path: 'src/a.ts', addedLines: 1 }],
    dropped: new Set(),
    mapPaths: new Set(['src/a.ts']),
    enumeratedPaths: new Set(['src/a.ts']),
    ...input,
  });

const kinds = (verdict: CrapVerdict) => verdict.problems.map((problem) => problem.kind);

test('the verdict blocks a touched function at or above the threshold', () => {
  const findings = readCrapFindings({ findings: [finding({})] }, 30);
  const verdict = decide({ findings });
  assert.equal(verdict.blocking, true);
  assert.deepEqual(verdict.problems, []);
  assert.deepEqual(verdict.offenders, findings);
});

test('the whole-repo verdict reports the backlog without blocking', () => {
  const verdict = decide({
    scope: 'all',
    findings: readCrapFindings({ findings: [finding({})] }, 30),
  });
  assert.equal(verdict.blocking, false);
  assert.deepEqual(verdict.offenders, []);
});

test('a touched file the sanitizer dropped is named once, as corrupt', () => {
  assert.deepEqual(
    kinds(
      decide({
        touched: [{ path: 'src/odd.ts', addedLines: 1 }],
        dropped: new Set(['src/odd.ts']),
      }),
    ),
    ['corrupt_touched'],
  );
});

test('an unmeasured touched function is a problem only in a file the map records', () => {
  const estimated = [{ path: 'src/a.ts', name: 'added', line: 40, crap: 42 }];
  // The map has the file but not the function: it predates the code and the score is a guess.
  assert.deepEqual(kinds(decide({ estimated })), ['unmeasured_touched']);
  // A file entirely outside the map is already reported as unscored, not also as unmeasured — and
  // an empty map is partial on its own, so both names appear and neither is a duplicate.
  assert.deepEqual(kinds(decide({ estimated, mapPaths: new Set() })), [
    'map_partial',
    'unscored_touched',
  ]);
});

test('an estimate in a file coverage never enumerated is listed, not blocked on', () => {
  // `scripts/**` and other out-of-scope files are the shape of a normal tooling PR: coverage does not
  // instrument them at all, so re-running cannot measure them and the estimate is the only score
  // available. Blocking would refuse every such PR; staying silent would hide a number ≥ 30.
  const verdict = decide({
    estimated: [{ path: 'scripts/tool.ts', name: 'parse', line: 12, crap: 31.6 }],
    touched: [{ path: 'scripts/tool.ts', addedLines: 3 }],
  });
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.blocking, false);
  assert.deepEqual(verdict.unscoped, [
    { path: 'scripts/tool.ts', name: 'parse', line: 12, crap: 31.6 },
  ]);
  const report = render({
    verdict,
  });
  assert.match(report, /no touched function\(s\) at or above 30/);
  assert.match(
    report,
    /Not measured, and not blocking.*`scripts\/tool\.ts:12` parse \(CRAP 31\.6\)/s,
  );
});

test('an estimate in a file the map predates stays a blocking problem, not a listing', () => {
  const verdict = decide({ estimated: [{ path: 'src/a.ts', name: 'added', line: 40, crap: 42 }] });
  assert.deepEqual(kinds(verdict), ['unmeasured_touched']);
  assert.deepEqual(verdict.unscoped, []);
  assert.equal(verdict.blocking, true);
});

test('an estimate is never called out-of-scope without an enumeration to check it against', () => {
  // Without lcov the run cannot tell "coverage does not instrument this" from "the run should have
  // measured this and did not" — the latter is the gap it already reports. Listing the file as
  // out-of-scope beside `no trustworthy verdict` would answer a question this run cannot ask.
  const verdict = decide({
    estimated: [{ path: 'scripts/tool.ts', name: 'parse', line: 12, crap: 31.6 }],
    touched: [{ path: 'scripts/tool.ts', addedLines: 3 }],
    mapPaths: new Set(),
    enumeratedPaths: null,
  });
  assert.deepEqual(verdict.unscoped, []);
  assert.equal(verdict.blocking, true);
  const report = render({
    verdict,
  });
  assert.doesNotMatch(report, /does not instrument/);
});

test('a map that records every enumerated file is trusted, and none is a partial map', () => {
  const both = ['src/a.ts', 'src/b.ts'];
  assert.deepEqual(kinds(decide({ mapPaths: new Set(both), enumeratedPaths: new Set(both) })), []);
  // One enumerated file the map does not record is enough to call the map incomplete.
  assert.deepEqual(
    kinds(decide({ mapPaths: new Set(['src/a.ts']), enumeratedPaths: new Set(both) })),
    ['map_partial'],
  );
});

test('a same-sized map holding the wrong paths is still a partial map', () => {
  // Two coverage runs mixed into one directory can produce equal counts over different files, and a
  // count comparison would call that complete. The check is per path, so one unrecorded file is
  // enough — and it names the touched file rather than only the discrepancy.
  const verdict = decide({
    mapPaths: new Set(['src/other.ts', 'src/b.ts']),
    enumeratedPaths: new Set(['src/a.ts', 'src/b.ts']),
  });
  assert.deepEqual(kinds(verdict), ['map_partial', 'unscored_touched']);
  assert.equal(verdict.blocking, true);
});

test('a run that recorded no files has no record of what it ran, and no verdict', () => {
  // A truncated or malformed lcov parses to nothing rather than failing, and every completeness
  // check reads this list: an empty one would silence them all and leave a clean-looking verdict.
  assert.deepEqual(kinds(decide({ enumeratedPaths: null })), ['enumeration_missing']);
  // The whole-repo backlog is scored from the map alone, so an absent lcov says nothing about it.
  assert.deepEqual(kinds(decide({ scope: 'all', enumeratedPaths: null })), []);
});

test('a coverage map is only readable as files to counter objects', () => {
  assert.deepEqual(parseIstanbulCoverageMap('{"src/a.ts":{"s":{"0":0}}}'), {
    'src/a.ts': { s: { 0: 0 } },
  });
  assert.throws(() => parseIstanbulCoverageMap('not json'), /not valid JSON/);
  assert.throws(() => parseIstanbulCoverageMap('[]'), /an array, not a file -> counters object/);
  assert.throws(() => parseIstanbulCoverageMap('{"src/a.ts":[]}'), /for src\/a\.ts is object/);
  assert.throws(() => parseIstanbulCoverageMap('{"src/a.ts":{"s":[]}}'), /has s as object/);
});

test("coverage keys from another checkout do not match this root's files", () => {
  const paths = coverageMapPaths(
    { '/work/other/src/a.ts': {}, 'src/relative.ts': {} },
    '/work/this',
  );
  assert.deepEqual([...paths], ['../other/src/a.ts', 'src/relative.ts']);
});

test('annotations put each finding on its file and line', () => {
  const findings = readCrapFindings({ findings: [finding({})] }, 30);
  assert.equal(
    renderCrapAnnotations(findings),
    '::warning file=src/a.ts,line=10,title=CRAP 42.0::run has cyclomatic 6 at 20%25 coverage.\n',
  );
});

test('annotations escape a path or name that would end the workflow command', () => {
  const findings = readCrapFindings(
    { findings: [finding({ path: 'src/a,b:c.ts', name: 'run\n::error::forged 100%' })] },
    30,
  );
  assert.equal(
    renderCrapAnnotations(findings),
    '::warning file=src/a%2Cb%3Ac.ts,line=10,title=CRAP 42.0::run%0A::error::forged 100%25 has cyclomatic 6 at 20%25 coverage.\n',
  );
});

test('a captured fallow 3.32 report yields its measured findings past leading output', () => {
  const report = fs.readFileSync(
    new URL('./fallow-health-report.fixture.json', import.meta.url),
    'utf8',
  );
  const findings = readCrapFindings(
    parseFallowJsonReport(`loaded config: fallow-crap.json\n${report}`),
    30,
  );
  assert.deepEqual(
    findings.map((entry) => [entry.path, entry.name, entry.line, entry.crap]),
    [
      // The captured fixture keeps the historical capture path: it never existed
      // at head (the module lives at the package root), so the sweep left it.
      ['src/daemon/handlers/session-state.ts', 'handleSessionStateCommands', 232, 34.1],
      ['src/daemon/handlers/session-state.ts', 'handleAppStateCommand', 112, 30.4],
    ],
  );
});

test('fallow output without a JSON report is an error', () => {
  assert.throws(() => parseFallowJsonReport('Error: coverage map rejected'), /no JSON report/);
});
