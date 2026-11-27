import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { discoverReplaySourcePaths } from '@agent-device/replay-port/source-discovery';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';

// `test <path-or-glob>` expands its patterns on the machine that typed the command, with a
// bounded directory walk rather than the Node glob call: that call is experimental below Node
// 22.17 and 24, and the supported floor is 22.12, where each call writes an ExperimentalWarning
// to stderr. These pin the shapes the walk has to keep, against a fixture built once.
const root = mkdtempForTestSync('agent-device-discovery-glob-');
const flows = path.join(root, 'flows');
fs.mkdirSync(path.join(flows, 'nested'), { recursive: true });
fs.mkdirSync(path.join(flows, '.cache'), { recursive: true });
fs.mkdirSync(path.join(root, 'brk[a]'), { recursive: true });
fs.mkdirSync(path.join(root, 'brka'), { recursive: true });
for (const relative of [
  'flows/01-native.ad',
  'flows/notes.txt',
  'flows/nested/02-second.ad',
  'flows/.cache/03-secret.ad',
  'brk[a]/04-bracket.ad',
  'brka/05-single.ad',
]) {
  fs.writeFileSync(path.join(root, relative), 'open "Demo"\n');
}
fs.symlinkSync('flows', path.join(root, 'link'));

const discover = (pattern: string) =>
  discoverReplaySourcePaths({ inputs: [pattern], cwd: root }).map((entry) =>
    path.relative(root, entry),
  );

test('suite globs expand one directory level without opening a nested route', () => {
  assert.deepEqual(discover('flows/*.ad'), ['flows/01-native.ad']);
  assert.deepEqual(discover('*/01-native.ad'), ['flows/01-native.ad']);
  assert.deepEqual(discover('missing/*.ad'), []);
});

test('suite globs expand a nested match through a ** segment', () => {
  assert.deepEqual(discover('flows/**/*.ad'), ['flows/01-native.ad', 'flows/nested/02-second.ad']);
  assert.deepEqual(discover('flows/nested/*.ad'), ['flows/nested/02-second.ad']);
});

test('suite globs reach every directory below cwd through a leading ** segment', () => {
  // A `**` segment names a directory by its own entry name, so the bracket-named directory is
  // reached there, where one `*` segment with a class would not be.
  assert.deepEqual(discover('**/*.ad'), [
    'brk[a]/04-bracket.ad',
    'brka/05-single.ad',
    'flows/01-native.ad',
    'flows/nested/02-second.ad',
  ]);
});

test('suite globs expand a brace list across a separator', () => {
  assert.deepEqual(discover('flows/{nested,.cache}/*.ad'), [
    'flows/.cache/03-secret.ad',
    'flows/nested/02-second.ad',
  ]);
});

test('suite globs reach a hidden directory only through a segment that names it', () => {
  assert.deepEqual(discover('flows/.cache/*.ad'), ['flows/.cache/03-secret.ad']);
  assert.deepEqual(discover('flows/*/*.ad'), ['flows/nested/02-second.ad']);
});

test('suite globs expand a trailing ** to the flows below it', () => {
  assert.deepEqual(discover('flows/**'), ['flows/01-native.ad', 'flows/nested/02-second.ad']);
});

test('suite globs read brackets as a character class, not as a literal name', () => {
  // The Node glob call has no escape for a bracket in a name: `[a]` is a class matching one
  // character, so the pattern reaches the sibling named `brka`, never the directory named
  // `brk[a]`. A pattern that names a route which really exists is a path, not a pattern.
  assert.deepEqual(discover('brk[a]/*.ad'), ['brka/05-single.ad']);
  assert.deepEqual(discover('brk[a]'), ['brk[a]/04-bracket.ad']);
  assert.deepEqual(discover('brk[a]/04-bracket.ad'), ['brk[a]/04-bracket.ad']);
});

test('suite globs follow a plain segment into a linked directory but not a wildcard one', () => {
  assert.deepEqual(discover('link/*.ad'), ['link/01-native.ad']);
  assert.deepEqual(discover('l*/*.ad'), []);
  // A `**` segment stops the walk from opening a link at all, so the same route is unreachable.
  assert.deepEqual(discover('**/link/*.ad'), []);
});

test('suite globs name a directory below a ** segment with its exact spelling', () => {
  // A `**` segment compares the segment to the entry name exactly, so one letter of the wrong case
  // names nothing, on a volume that ignores case as much as on one that does not.
  assert.deepEqual(discover('**/nested/*.ad'), ['flows/nested/02-second.ad']);
  assert.deepEqual(discover('**/Nested/*.ad'), []);
});

test('suite globs name nothing for a route below a file instead of failing the read', () => {
  // The glob call reads each segment as a directory. Below Node 22.17 and 24, one that names a
  // file made it throw ENOTDIR, so a suite path typed one level too deep stopped the command.
  assert.deepEqual(discover('flows/01-native.{ad,txt}/nope'), []);
  assert.deepEqual(discover('flows/01-native.{ad,txt}/*.ad'), []);
});

test('suite globs drop a non-match by extension from an expanded route', () => {
  assert.deepEqual(discover('flows/*'), ['flows/01-native.ad']);
});

test('suite glob expansion calls no Node glob API', () => {
  // The glob call is experimental below Node 22.17 and 24, and the supported floor is 22.12,
  // where each call writes an ExperimentalWarning to stderr and pollutes CLI output.
  const globSync = vi.spyOn(fs, 'globSync');
  const matches = discover('flows/**/*.ad');

  assert.deepEqual(matches, ['flows/01-native.ad', 'flows/nested/02-second.ad']);
  assert.equal(globSync.mock.calls.length, 0);
  globSync.mockRestore();
});
