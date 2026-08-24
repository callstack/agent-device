import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSeams, findSeamMatches } from './model.ts';

test('findSeamMatches finds an optional typeof field with its line number', () => {
  const matches = findSeamMatches([
    { path: 'a.ts', source: 'type T = {\n  dispatch?: typeof dispatchCommand;\n};\n' },
  ]);
  assert.deepEqual(matches, [
    {
      file: 'a.ts',
      line: 2,
      field: 'dispatch',
      target: 'dispatchCommand',
      text: 'dispatch?: typeof dispatchCommand;',
    },
  ]);
});

test('findSeamMatches ignores a required (non-optional) field', () => {
  const matches = findSeamMatches([
    { path: 'a.ts', source: 'type T = { dispatch: typeof dispatchCommand };' },
  ]);
  assert.deepEqual(matches, []);
});

test('checkSeams passes a match whose exact (file, field, target) triple is approved', () => {
  const matches = findSeamMatches([{ path: 'src/x.ts', source: 'fetchImpl?: typeof fetch;' }]);
  const { violations, staleApprovals } = checkSeams(matches, [
    { file: 'src/x.ts', field: 'fetchImpl', target: 'fetch', reason: 'test' },
  ]);
  assert.deepEqual(violations, []);
  assert.deepEqual(staleApprovals, []);
});

// This is the exact failure mode PR #2006's review flagged in the earlier name-based version:
// approving `typeof fetch` in one file must not silently approve it everywhere.
test('checkSeams flags the same field/target seam in an unapproved file', () => {
  const matches = findSeamMatches([{ path: 'src/y.ts', source: 'fetchImpl?: typeof fetch;' }]);
  const { violations } = checkSeams(matches, [
    { file: 'src/x.ts', field: 'fetchImpl', target: 'fetch', reason: 'test' },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.file, 'src/y.ts');
});

test('checkSeams flags an unapproved field name in an approved file, even for an approved target', () => {
  const matches = findSeamMatches([{ path: 'src/x.ts', source: 'otherField?: typeof fetch;' }]);
  const { violations } = checkSeams(matches, [
    { file: 'src/x.ts', field: 'fetchImpl', target: 'fetch', reason: 'test' },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.field, 'otherField');
});

test('checkSeams flags a seam under a different target, even for an approved field name', () => {
  const matches = findSeamMatches([{ path: 'src/x.ts', source: 'fetchImpl?: typeof otherFn;' }]);
  const { violations } = checkSeams(matches, [
    { file: 'src/x.ts', field: 'fetchImpl', target: 'fetch', reason: 'test' },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.target, 'otherFn');
});

test('checkSeams reports an approval as stale when its triple matches nothing', () => {
  const { staleApprovals, violations } = checkSeams(
    [],
    [{ file: 'src/x.ts', field: 'fetchImpl', target: 'fetch', reason: 'test' }],
  );
  assert.equal(violations.length, 0);
  assert.equal(staleApprovals.length, 1);
  assert.equal(staleApprovals[0]?.field, 'fetchImpl');
});

test('checkSeams approves every occurrence of the same triple within a file', () => {
  const matches = findSeamMatches([
    {
      path: 'src/x.ts',
      source: 'fetchImpl?: typeof fetch;\n// ...\nfetchImpl?: typeof fetch;\n',
    },
  ]);
  const { violations, staleApprovals } = checkSeams(matches, [
    { file: 'src/x.ts', field: 'fetchImpl', target: 'fetch', reason: 'test' },
  ]);
  assert.deepEqual(violations, []);
  assert.deepEqual(staleApprovals, []);
});
