import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUnifiedDiff } from './repo-git.ts';

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
