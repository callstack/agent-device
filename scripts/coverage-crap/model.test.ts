import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  parseFallowJsonReport,
  readCrapFindings,
  renderCrapAnnotations,
  renderCrapReport,
  sanitizeIstanbulCoverage,
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

test('the report names touched functions and unscored files', () => {
  const findings = readCrapFindings({ findings: [finding({})] }, 30);
  const report = renderCrapReport({
    findings,
    dropped: ['src/odd.ts'],
    threshold: 30,
    scope: 'touched',
  });
  assert.match(report, /1 touched function\(s\) at or above 30/);
  assert.match(report, /\| `src\/a\.ts:10` run \| 42\.0 \| 6 \| 20% \|/);
  assert.match(report, /Unscored: 1 file\(s\).*`src\/odd\.ts`/);
});

test('an empty report says none and lists no table', () => {
  const report = renderCrapReport({ findings: [], dropped: [], threshold: 30, scope: 'touched' });
  assert.match(report, /: no touched function/);
  assert.doesNotMatch(report, /\| Function/);
});

test('a whole-repository report does not claim the functions were touched', () => {
  const findings = readCrapFindings({ findings: [finding({})] }, 30);
  const report = renderCrapReport({ findings, dropped: [], threshold: 30, scope: 'all' });
  assert.match(report, /: 1 function\(s\) at or above 30/);
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
      ['src/daemon/handlers/session-state.ts', 'handleSessionStateCommands', 232, 34.1],
      ['src/daemon/handlers/session-state.ts', 'handleAppStateCommand', 112, 30.4],
    ],
  );
});

test('fallow output without a JSON report is an error', () => {
  assert.throws(() => parseFallowJsonReport('Error: coverage map rejected'), /no JSON report/);
});
