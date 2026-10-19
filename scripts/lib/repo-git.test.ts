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

// The object modes below are what `git diff` writes in its headers, verified against
// real diffs: a symlink's added line is its target path, a gitlink's is
// `Subproject commit <sha>`, and both resolve in the working tree to something a
// content read cannot take (EISDIR for a symlink to a directory). Content readers
// skip what `regularFile` rules out, so the parse must read the mode from the
// headers rather than trust the body.
test('parseUnifiedDiff reads the new-side object mode as regularFile', () => {
  const diff = [
    'diff --git a/tools/helper-tests/Sources b/tools/helper-tests/Sources',
    'new file mode 120000',
    'index 0000000..e94dfd3',
    '--- /dev/null',
    '+++ b/tools/helper-tests/Sources',
    '@@ -0,0 +1 @@',
    '+../helper/Sources',
    String.raw`\ No newline at end of file`,
    'diff --git a/vendor/lib b/vendor/lib',
    'index 40287e1..6f36720 160000',
    '--- a/vendor/lib',
    '+++ b/vendor/lib',
    '@@ -1 +1 @@',
    '-Subproject commit 40287e12bdee20e6666847781ad1e618ef185015',
    '+Subproject commit 6f36720aa717698e572f0dec47f1ca11adcc190c',
    'diff --git a/src/kept.ts b/src/kept.ts',
    'index 6178079..c3219eb 100644',
    '--- a/src/kept.ts',
    '+++ b/src/kept.ts',
    '@@ -1,0 +2 @@',
    '+const kept = 1;',
  ].join('\n');
  const files = parseUnifiedDiff(diff);
  const link = files.find((f) => f.path === 'tools/helper-tests/Sources');
  assert.deepEqual(link?.added, [1]);
  assert.equal(link?.regularFile, false);
  const gitlink = files.find((f) => f.path === 'vendor/lib');
  assert.deepEqual(gitlink?.added, [1]);
  assert.equal(gitlink?.regularFile, false);
  const kept = files.find((f) => f.path === 'src/kept.ts');
  assert.equal(kept?.regularFile, true);
});

test('parseUnifiedDiff reads mode-change and deletion headers as regular-file sides', () => {
  const diff = [
    'diff --git a/tools/build.sh b/tools/build.sh',
    'old mode 100644',
    'new mode 100755',
    'index 562890b..562890b',
    'diff --git a/src/gone.ts b/src/gone.ts',
    'deleted file mode 100644',
    'index 7898192..0000000',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-was here',
    'diff --git a/gone-link b/gone-link',
    'deleted file mode 120000',
    'index c59d9b6..0000000',
    '--- a/gone-link',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-target',
  ].join('\n');
  const files = parseUnifiedDiff(diff);
  // An executable-bit change stays a regular file; a deletion has no new-side
  // content to read whatever the removed side's mode was.
  const modes = files.find((f) => f.path === 'tools/build.sh');
  assert.equal(modes?.regularFile, true);
  assert.equal(files.find((f) => f.path === 'src/gone.ts')?.deleted, true);
  const goneLink = files.find((f) => f.path === 'gone-link');
  assert.equal(goneLink?.deleted, true);
  assert.equal(goneLink?.regularFile, false);
});
