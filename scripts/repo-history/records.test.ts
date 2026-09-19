import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MINI_REPO_COMMITS,
  MINI_REPO_FILES,
  MINI_REPO_PATHS as P,
} from './__fixtures__/mini-repo.ts';
import { arrivedViaRename, firstTouchRecords } from './records.ts';
import { buildRenameMap, createPathResolver } from './renames.ts';

function records() {
  return firstTouchRecords(
    MINI_REPO_COMMITS,
    new Set(MINI_REPO_FILES),
    createPathResolver(buildRenameMap(MINI_REPO_COMMITS)),
  );
}

test('a file born in place and never moved records its add commit', () => {
  const x = records().get(P.X)!;
  assert.deepEqual(x, {
    id: P.X,
    sha: 'c01',
    date: '2026-01-05T12:00:00+00:00',
    subject: 'feat(alpha): add the alpha and beta modules',
    status: 'A',
    path: P.X,
  });
  assert.equal(arrivedViaRename(x), false);
  assert.equal(records().get(P.Y)!.sha, 'c08');
});

test('a renamed file records the commit that placed it at its current path', () => {
  const b2 = records().get(P.B2)!;
  assert.deepEqual(
    [b2.sha, b2.status, b2.path, b2.subject],
    ['c07', 'R', P.B2, 'refactor: move b1 to gamma'],
  );
  assert.equal(arrivedViaRename(b2), true);
  const z = records().get(P.Z)!;
  assert.deepEqual([z.sha, z.status, z.path], ['c12', 'R', P.Z]);
  assert.equal(arrivedViaRename(z), true);
});

test('a reused path resolves each rename record onto its own target', () => {
  const w = records().get(P.W)!;
  assert.deepEqual([w.sha, w.status, w.path], ['c03', 'R', P.W]);
  const w2 = records().get(P.W2)!;
  assert.deepEqual([w2.sha, w2.status, w2.path], ['c05', 'R', P.W2]);
});

test('a historical path that no longer exists is dropped, not counted', () => {
  const all = records();
  assert.equal(all.has(P.OLD), false);
  assert.equal(all.has('README.md'), false);
  assert.deepEqual(
    [...all.keys()].sort(),
    [...MINI_REPO_FILES].filter((file) => !file.startsWith('packages/mass/')).sort(),
  );
});
