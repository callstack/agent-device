import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MASS_FILES,
  MINI_REPO_COMMITS,
  MINI_REPO_FILES,
  MINI_REPO_PATHS as P,
} from './__fixtures__/mini-repo.ts';
import { resolveCommitFiles } from './commits.ts';
import { buildRenameMap, createPathResolver } from './renames.ts';

function commits() {
  return resolveCommitFiles(
    MINI_REPO_COMMITS,
    new Set(MINI_REPO_FILES),
    createPathResolver(buildRenameMap(MINI_REPO_COMMITS)),
  );
}

function filesOf(sha: string): readonly string[] {
  return commits().find((commit) => commit.sha === sha)!.files;
}

test('keeps one entry per raw commit, oldest first', () => {
  assert.deepEqual(
    commits().map((commit) => commit.sha),
    MINI_REPO_COMMITS.map((commit) => commit.sha),
  );
});

test('resolves renamed paths to today and drops deleted and non-production paths', () => {
  assert.deepEqual(filesOf('c01'), [P.A, P.B2, P.X].sort());
  assert.deepEqual(filesOf('c06'), [P.A, P.B2].sort());
  assert.deepEqual(filesOf('c11'), [P.X, P.Z].sort());
  assert.deepEqual(filesOf('c10'), []);
  assert.deepEqual(filesOf('c16'), []);
});

test('a reused path lands on the later rename target', () => {
  assert.deepEqual(filesOf('c02'), [P.W2]);
  assert.deepEqual(filesOf('c03'), [P.W]);
  assert.deepEqual(filesOf('c04'), [P.W2]);
});

test('the mass commit keeps all 61 files for the consumer to skip', () => {
  assert.deepEqual(filesOf('c15'), [...MASS_FILES].sort());
});
