import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHANGED_LINE_COVERAGE_THRESHOLD,
  computeChangedCoverage,
  ignoredLineSet,
  isIncludableSource,
  isTestFile,
  normalizePath,
  parseLcov,
  parseUnifiedDiff,
  type ChangedFileDiff,
} from './model.ts';

test('normalizePath strips root, b/ and ./ prefixes and posixifies', () => {
  assert.equal(normalizePath('/repo/src/a.ts', '/repo'), 'src/a.ts');
  assert.equal(normalizePath('b/src/a.ts'), 'src/a.ts');
  assert.equal(normalizePath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizePath(String.raw`src\a.ts`), 'src/a.ts');
});

test('parseLcov reads DA hits and BRDA taken, treating "-" as not taken', () => {
  const lcov = [
    'SF:/repo/src/a.ts',
    'DA:1,3',
    'DA:2,0',
    'BRDA:1,0,0,3',
    'BRDA:2,1,0,-',
    'end_of_record',
    'SF:src/b.ts',
    'DA:10,1',
    'end_of_record',
  ].join('\n');
  const index = parseLcov(lcov, '/repo');
  const a = index.get('src/a.ts');
  assert.ok(a);
  assert.equal(a.lineHits.get(1), 3);
  assert.equal(a.lineHits.get(2), 0);
  assert.deepEqual(a.branches, [
    { line: 1, taken: 3 },
    { line: 2, taken: 0 },
  ]);
  assert.equal(index.get('src/b.ts')?.lineHits.get(10), 1);
});

test('parseUnifiedDiff numbers added lines per hunk and ignores deleted lines', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,0 +1,2 @@',
    '+const a = 1;',
    '+const b = 2;',
    '@@ -10,1 +12,1 @@',
    '-old line',
    '+new line',
  ].join('\n');
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.path, 'src/a.ts');
  assert.equal(file.deleted, false);
  assert.deepEqual(file.added, [1, 2, 12]);
});

test('parseUnifiedDiff marks deleted files and keeps rename destinations', () => {
  const diff = [
    'diff --git a/src/gone.ts b/src/gone.ts',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-was here',
    'diff --git a/src/old.ts b/src/new.ts',
    'rename from src/old.ts',
    'rename to src/new.ts',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    '@@ -3,0 +4,1 @@',
    '+added on new path',
  ].join('\n');
  const files = parseUnifiedDiff(diff);
  const gone = files.find((f) => f.path === 'src/gone.ts');
  assert.equal(gone?.deleted, true);
  const renamed = files.find((f) => f.path === 'src/new.ts');
  assert.deepEqual(renamed?.added, [4]);
});

test('source/test classification matches the coverage include glob', () => {
  assert.equal(isIncludableSource('src/core/x.ts'), true);
  assert.equal(isIncludableSource('src/core/x.test.ts'), false);
  assert.equal(isIncludableSource('src/core/__tests__/x.ts'), false);
  assert.equal(isIncludableSource('scripts/y.ts'), false);
  assert.equal(isIncludableSource('src/core/x.tsx'), false);
  // Workspace packages are the second coverage root.
  assert.equal(isIncludableSource('packages/contracts/src/x.ts'), true);
  assert.equal(isIncludableSource('packages/contracts/src/deep/x.ts'), true);
  assert.equal(isIncludableSource('packages/contracts/src/x.test.ts'), false);
  assert.equal(isIncludableSource('packages/contracts/src/__tests__/x.ts'), false);
  assert.equal(isIncludableSource('packages/contracts/src/x.tsx'), false);
  assert.equal(isIncludableSource('packages/contracts/test/x.ts'), false);
  assert.equal(isIncludableSource('packages/contracts/x.ts'), false);
  assert.equal(isTestFile('src/a.test.ts'), true);
  assert.equal(isTestFile('src/__tests__/a.ts'), true);
  assert.equal(isTestFile('src/a.ts'), false);
});

test('ignoredLineSet handles next, next N and start/stop ranges', () => {
  const lines = [
    'const a = 1;', // 1
    '/* v8 ignore next */', // 2
    'const b = 2;', // 3 ignored
    '/* c8 ignore next 2 */', // 4
    'const c = 3;', // 5 ignored
    'const d = 4;', // 6 ignored
    '/* istanbul ignore start */', // 7 ignored
    'const e = 5;', // 8 ignored
    '/* istanbul ignore stop */', // 9
    'const f = 6;', // 10
  ];
  const ignored = ignoredLineSet(lines);
  assert.deepEqual(
    [...ignored].sort((a, b) => a - b),
    [3, 5, 6, 7, 8],
  );
});

const coverage = parseLcov(
  [
    'SF:src/covered.ts',
    'DA:1,5',
    'DA:2,0',
    'DA:3,2',
    'BRDA:1,0,0,5',
    'BRDA:2,0,0,0',
    'end_of_record',
  ].join('\n'),
);

function diff(path: string, added: number[], deleted = false): ChangedFileDiff {
  return { path, added, deleted };
}

test('gate fails when changed-line coverage is below threshold and lists offenders', () => {
  const result = computeChangedCoverage({
    diffs: [diff('src/covered.ts', [1, 2, 3])],
    coverage,
    fileLines: () => null,
  });
  // lines 1 & 3 covered, line 2 uncovered -> 2/3 = 66.67% < 70.
  assert.equal(result.totalLines, 3);
  assert.equal(result.coveredLines, 2);
  assert.equal(result.passed, false);
  assert.deepEqual(result.offenders[0]?.uncoveredLines, [2]);
  assert.equal(result.offenders[0]?.path, 'src/covered.ts');
  // Branches on changed lines are reported, not gated.
  assert.equal(result.branch.total, 2);
  assert.equal(result.branch.covered, 1);
});

test('workspace package source counts toward the gate like root source', () => {
  const packageCoverage = parseLcov(
    ['SF:packages/contracts/src/feature.ts', 'DA:1,4', 'DA:2,0', 'end_of_record'].join('\n'),
  );
  const result = computeChangedCoverage({
    diffs: [diff('packages/contracts/src/feature.ts', [1, 2])],
    coverage: packageCoverage,
    fileLines: () => null,
  });
  // 1/2 = 50% < 70: a package change can now fail the gate on its own.
  assert.equal(result.totalLines, 2);
  assert.equal(result.coveredLines, 1);
  assert.equal(result.passed, false);
  assert.equal(result.offenders[0]?.path, 'packages/contracts/src/feature.ts');
  assert.deepEqual(result.offenders[0]?.uncoveredLines, [2]);
});

test('non-executable added lines (absent from DA) never enter the denominator', () => {
  const result = computeChangedCoverage({
    diffs: [diff('src/covered.ts', [1, 3, 99])],
    coverage,
    fileLines: () => null,
  });
  assert.equal(result.totalLines, 2);
  assert.equal(result.coveredLines, 2);
  assert.equal(result.pct, 100);
  assert.equal(result.passed, true);
});

test('deleted files and docs-only changes are a trivial pass with null pct', () => {
  const result = computeChangedCoverage({
    diffs: [diff('src/covered.ts', [1], true), diff('README.md', [1, 2])],
    coverage,
    fileLines: () => null,
  });
  assert.equal(result.pct, null);
  assert.equal(result.totalLines, 0);
  assert.equal(result.passed, true);
});

test('waiver forces a pass but still reports the numbers', () => {
  const result = computeChangedCoverage({
    diffs: [diff('src/covered.ts', [1, 2, 3])],
    coverage,
    waived: true,
    fileLines: () => null,
  });
  assert.equal(result.waived, true);
  assert.equal(result.passed, true);
  assert.equal(result.pct, 66.67);
});

test('includable source absent from lcov counts as excluded-path code lines', () => {
  const result = computeChangedCoverage({
    diffs: [diff('src/sdk/thing.ts', [1, 2, 3])],
    coverage,
    fileLines: () => ['const kept = 1;', '', '// a comment'],
  });
  assert.equal(result.totalLines, 0);
  assert.equal(result.excluded.totalLines, 1);
  assert.equal(result.excluded.files[0]?.reason, 'excluded-path');
  assert.deepEqual(result.excluded.files[0]?.lines, [1]);
});

test('changed line suppressed by an ignore directive is tallied, not gated', () => {
  const cov = parseLcov(['SF:src/x.ts', 'DA:1,1', 'end_of_record'].join('\n'));
  const result = computeChangedCoverage({
    diffs: [diff('src/x.ts', [1, 3])],
    coverage: cov,
    fileLines: () => ['const a = 1;', '/* v8 ignore next */', 'const suppressed = 3;'],
  });
  // Line 3 is code-like, dropped from DA by the directive on line 2, and inside
  // its ignore range: it lands in the non-gating excluded tally. Only line 1
  // (present in DA) feeds the gate denominator, so the tally never inflates it.
  assert.equal(result.totalLines, 1);
  assert.equal(result.coveredLines, 1);
  assert.equal(result.excluded.totalLines, 1);
  assert.equal(result.excluded.files[0]?.reason, 'ignored-lines');
  assert.deepEqual(result.excluded.files[0]?.lines, [3]);
});

test('threshold constant is the single source of truth', () => {
  assert.equal(CHANGED_LINE_COVERAGE_THRESHOLD, 70);
});
