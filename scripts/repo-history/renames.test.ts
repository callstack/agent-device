import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINI_REPO_COMMITS, MINI_REPO_PATHS as P } from './__fixtures__/mini-repo.ts';
import { buildRenameMap, createPathResolver } from './renames.ts';

test('collects every rename record, later commits overriding an earlier key', () => {
  const renames = buildRenameMap(MINI_REPO_COMMITS);
  assert.deepEqual(
    [...renames.entries()].sort(),
    [
      [P.B, P.B1],
      [P.B1, P.B2],
      [P.W_OLD, P.W2],
      [P.Z_OLD, P.Z],
    ].sort(),
  );
});

test('resolves a rename applied twice in history to the current path', () => {
  const resolve = createPathResolver(buildRenameMap(MINI_REPO_COMMITS));
  assert.equal(resolve(P.B), P.B2);
  assert.equal(resolve(P.B1), P.B2);
  assert.equal(resolve(P.B2), P.B2);
  assert.equal(resolve(P.Z_OLD), P.Z);
  assert.equal(resolve(P.OLD), P.OLD);
});

test('a reused path follows the later rename by declaration', () => {
  const resolve = createPathResolver(buildRenameMap(MINI_REPO_COMMITS));
  assert.equal(resolve(P.W_OLD), P.W2);
});

test('stops at a rename cycle and memoises the answer', () => {
  const renames = new Map([
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'a'],
  ]);
  const resolve = createPathResolver(renames);
  const first = resolve('a');
  assert.equal(['a', 'b', 'c'].includes(first), true);
  assert.equal(resolve('a'), first);
  renames.set('a', 'z');
  assert.equal(resolve('a'), first, 'memoised result survives a later map change');
});
