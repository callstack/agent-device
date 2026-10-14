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
import type { CoverageConfig } from './stamp.ts';

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
  uninstrumented: [],
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
  uninstrumented: readonly EstimatedFinding[] = [],
) => ({
  blocking: true,
  problems,
  uninstrumented,
  offenders: [],
});

test('the report names touched functions and unscored files', () => {
  const findings = readCrapFindings({ findings: [finding({})] }, 30);
  const report = render({
    findings,
    dropped: ['src/odd.ts'],
    verdict: { blocking: true, problems: [], uninstrumented: [], offenders: findings },
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
      { kind: 'unrecorded_eligible', files: [{ path: 'src/new.ts', addedLines: 4 }] },
      { kind: 'corrupt_touched', files: ['src/odd.ts'] },
    ]),
  });
  assert.match(report, /no trustworthy verdict/);
  assert.match(report, /no record in the coverage map\*\*: `src\/new\.ts` \(4 changed line\(s\)\)/);
  assert.match(report, /impossible counts\*\*: `src\/odd\.ts`/);
  // Every problem carries the command that clears it, since the reader has no other way to act.
  assert.match(report, /Run `pnpm test:coverage` again/);
});

test('the same gap in the whole-repo report is a note, not a verdict', () => {
  const report = render({
    scope: 'all',
    verdict: {
      ...verdictWith([{ kind: 'corrupt_touched', files: ['src/odd.ts'] }]),
      blocking: false,
    },
  });
  assert.match(report, /report-only\): no function\(s\) at or above 30/);
  assert.match(report, /Not gating, but the report is incomplete/);
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

/** What the run declared it instruments; `scripts/**` is outside it, as in `vitest.config.ts`. */
const CONFIG: CoverageConfig = { include: ['src/**/*.ts'], exclude: ['src/generated/**'] };

/**
 * A verdict over one touched file the map records, with whatever a case cares about overridden. The
 * defaults are the shape of a clean answer, so each case states only its difference.
 */
const decide = (input: Partial<Parameters<typeof decideCrapVerdict>[0]> = {}) =>
  decideCrapVerdict({
    scope: 'touched',
    findings: [],
    estimated: [],
    touched: [{ path: 'src/a.ts', addedLines: 1 }],
    dropped: new Set(),
    mapPaths: new Set(['src/a.ts']),
    coverage: CONFIG,
    ignoredFiles: new Set(),
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
  // `mapPaths` is the pre-sanitizer key set, so a dropped record is corrupt and never also missing,
  // which is the one shape that would otherwise print advice to re-run for counts a re-run repeats.
  const verdict = decide({
    touched: [{ path: 'src/odd.ts', addedLines: 1 }],
    mapPaths: new Set(['src/odd.ts']),
    dropped: new Set(['src/odd.ts']),
    estimated: [{ path: 'src/odd.ts', name: 'parse', line: 12, crap: 42 }],
  });
  assert.deepEqual(kinds(verdict), ['corrupt_touched']);
  assert.deepEqual(verdict.uninstrumented, []);
});

test('a touched file the config instruments and the map omits is a gap', () => {
  const verdict = decide({ touched: [{ path: 'src/new.ts', addedLines: 3 }] });
  assert.deepEqual(kinds(verdict), ['unrecorded_eligible']);
  assert.equal(verdict.blocking, true);
});

test('a touched file the config excludes is not a gap, and its estimate is listed', () => {
  // A tooling PR is the ordinary shape of this: coverage never instruments `scripts/**`, so no
  // re-run would score it. Blocking would refuse every such change; staying silent would hide the 42.
  const verdict = decide({
    touched: [{ path: 'scripts/tool.ts', addedLines: 3 }],
    mapPaths: new Set(),
    estimated: [{ path: 'scripts/tool.ts', name: 'parse', line: 12, crap: 31.6 }],
  });
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.blocking, false);
  assert.deepEqual(verdict.uninstrumented, [
    { path: 'scripts/tool.ts', name: 'parse', line: 12, crap: 31.6 },
  ]);
  const report = render({ verdict });
  assert.match(report, /no touched function\(s\) at or above 30/);
  assert.match(
    report,
    /Not measured, and not blocking.*`scripts\/tool\.ts:12` parse \(CRAP 31\.6\)/s,
  );
});

test('an estimate inside a file the map records is listed, not blocked on', () => {
  // The stamp proves the map describes this tree, so a function it omits predates nothing: an ignore
  // comment discarded its lines or it runs out of process. Either way a re-run cannot measure it, so
  // the report says so instead of sending the reader to re-run coverage forever.
  const verdict = decide({ estimated: [{ path: 'src/a.ts', name: 'runJob', line: 40, crap: 42 }] });
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.blocking, false);
  assert.deepEqual(verdict.uninstrumented, [
    { path: 'src/a.ts', name: 'runJob', line: 40, crap: 42 },
  ]);
});

test('an excluded path is not a gap either', () => {
  const verdict = decide({
    touched: [{ path: 'src/generated/table.ts', addedLines: 4 }],
    mapPaths: new Set(),
  });
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.blocking, false);
});

test('a file whose source declares itself outside coverage is not a gap', () => {
  // No run records it, so `unrecorded_eligible` would refuse the file permanently.
  const verdict = decide({
    touched: [{ path: 'src/a.ts', addedLines: 4 }],
    mapPaths: new Set(),
    ignoredFiles: new Set(['src/a.ts']),
    estimated: [{ path: 'src/a.ts', name: 'pageScript', line: 3, crap: 42 }],
  });
  assert.deepEqual(verdict.problems, []);
  assert.deepEqual(verdict.uninstrumented, [
    { path: 'src/a.ts', name: 'pageScript', line: 3, crap: 42 },
  ]);
});

test('without a declared config the verdict cannot call a missing record a gap', () => {
  // `--all` asks no per-file question of a diff, and a run with no stamp never reaches the verdict.
  // Calling an uninstrumented file a gap, or out of scope, would both be claims this run cannot make.
  const verdict = decide({
    touched: [{ path: 'scripts/tool.ts', addedLines: 3 }],
    mapPaths: new Set(),
    coverage: null,
    estimated: [{ path: 'scripts/tool.ts', name: 'parse', line: 12, crap: 31.6 }],
  });
  assert.deepEqual(verdict.problems, []);
  assert.deepEqual(verdict.uninstrumented, []);
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
