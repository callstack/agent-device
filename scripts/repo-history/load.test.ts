import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { loadRepoHistory } from './load.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

test('the live model covers the layering file set and resolves onto it', () => {
  const history = loadRepoHistory(repoRoot);
  const files = new Set(history.files);
  assert.equal(files.size > 0, true);
  assert.equal(history.commits.length > 0, true);
  for (const id of history.firstTouch.keys()) assert.equal(files.has(id), true, id);
  for (const commit of history.commits) {
    for (const file of commit.files) assert.equal(files.has(file), true, `${commit.sha} ${file}`);
  }
  // A first touch is the earliest record in a lineage, so the map cannot exceed the file set.
  assert.equal(history.firstTouch.size <= files.size, true);
});
