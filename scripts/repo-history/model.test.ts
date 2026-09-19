import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MINI_REPO_COMMITS,
  MINI_REPO_FILES,
  MINI_REPO_PATHS as P,
} from './__fixtures__/mini-repo.ts';
import { buildRepoHistory } from './model.ts';

test('assembles renames, first-touch records, and commit file sets from one raw log', () => {
  const history = buildRepoHistory(MINI_REPO_COMMITS, new Set(MINI_REPO_FILES));
  assert.equal(history.commits.length, MINI_REPO_COMMITS.length);
  assert.equal(history.renames.size, 4);
  assert.equal(history.resolve(P.B), P.B2);
  assert.equal(history.firstTouch.get(P.B2)!.sha, 'c07');
  assert.deepEqual(history.commits[0]!.files, [P.A, P.B2, P.X].sort());
});

test('every first-touch id is a current file and appears in its own commit', () => {
  const history = buildRepoHistory(MINI_REPO_COMMITS, new Set(MINI_REPO_FILES));
  const current = new Set(MINI_REPO_FILES);
  for (const [id, record] of history.firstTouch) {
    assert.equal(current.has(id), true);
    const commit = history.commits.find((entry) => entry.sha === record.sha)!;
    assert.equal(commit.files.includes(id), true, `${id} missing from ${record.sha}`);
  }
});
