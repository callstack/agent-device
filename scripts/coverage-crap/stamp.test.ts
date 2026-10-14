import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  COVERAGE_STAMP_FILE,
  beginCoverageRun,
  finishCoverageRun,
  type CoverageConfig,
  type CoverageRun,
  type CoverageStamp,
  type CoverageStampWrite,
  type RunSelection,
} from './stamp.ts';

// The stamp is the only thing that tells a later verdict its coverage map is this checkout's, so these run
// the writer against a real git repo on disk: an in-place edit, a new or renamed or deleted path, an edit
// made while the pass ran, and a checkout with no commit each have to land where they belong.

let repo: string;

const CONFIG: CoverageConfig = { include: ['src/**/*.ts'], exclude: ['src/generated/**'] };
const COVERAGE_DIR = 'coverage';
const STAMP_PATH = `${COVERAGE_DIR}/${COVERAGE_STAMP_FILE}`;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(rel: string, content: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function finish(run: CoverageRun, runSelection: RunSelection = 'full'): CoverageStampWrite {
  return finishCoverageRun(run, path.join(repo, COVERAGE_DIR), CONFIG, runSelection);
}

/** A whole pass over the current tree, which is what the tests below mostly need. */
function stamp(runSelection: RunSelection = 'full'): CoverageStamp {
  const outcome = finish(beginCoverageRun(repo), runSelection);
  assert.ok('written' in outcome, 'expected a pass over an unmoved tree to write its stamp');
  return outcome.written;
}

function stampOnDisk(): CoverageStamp | null {
  return fs.existsSync(path.join(repo, STAMP_PATH))
    ? (JSON.parse(fs.readFileSync(path.join(repo, STAMP_PATH), 'utf8')) as CoverageStamp)
    : null;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-stamp-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  // The stamp itself lives in the reports directory, so that directory has to stay outside the tree the
  // hash describes — this mirrors this repository's own `.gitignore`, which is what keeps writing the
  // record from moving the hash it just computed.
  write('.gitignore', 'coverage/\ndist/\n');
  write('src/a.ts', 'export const a = 1;\n');
  write('src/a.test.ts', 'test("a", () => {});\n');
  write('src/generated/table.ts', 'export const table = 1;\n');
  write('scripts/tool.ts', 'export const tool = 1;\n');
  write('vitest.config.ts', 'export default { test: {} };\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

test('an in-place body change moves the hash the stamp pinned', () => {
  const before = stamp().workingTreeHash;

  // Same length, same file list, same line count: only a content hash catches this, which is the case
  // where file lists and function spans still agree.
  write('src/a.ts', 'export const a = 2;\n');

  assert.notEqual(stamp().workingTreeHash, before);
});

test('editing a file the config excludes still moves the hash', () => {
  // The loop the stamp exists for: the map is produced by running tests, so the tree a coverage pass reads
  // is every file it could load, not only the files it scores. `scripts/tool.ts` is excluded from
  // instrumentation and `src/generated/table.ts` is excluded by the config, and neither moves a source
  // file's own score — but both are inputs to what a run does, so both have to move the record. The case
  // that matters is the test file below.
  const before = stamp().workingTreeHash;

  write('src/a.test.ts', 'test("a", () => {});\ntest("b", () => {});\n');
  assert.notEqual(stamp().workingTreeHash, before);

  write('scripts/tool.ts', 'export const tool = 2;\n');
  assert.notEqual(stamp().workingTreeHash, before);
});

test('editing the config or a setup file moves the hash', () => {
  // Widening `test.coverage.include` admits files the old map never looked at, and a setup file changes
  // what every test does. Both are ordinary working-tree files, so neither needs its own rule.
  const before = stamp().workingTreeHash;

  write('vitest.config.ts', 'export default { test: { coverage: { include: [] } } };\n');
  assert.notEqual(stamp().workingTreeHash, before);

  write('src/__tests__/hermetic-env-setup.ts', 'export default 2;\n');
  assert.notEqual(stamp().workingTreeHash, before);
});

test('a new or removed file anywhere moves the hash', () => {
  const before = stamp().workingTreeHash;
  write('src/b.ts', 'export const b = 1;\n');
  assert.notEqual(stamp().workingTreeHash, before);

  fs.rmSync(path.join(repo, 'src/b.ts'));
  assert.equal(stamp().workingTreeHash, before);
});

test('a tracked file deleted without committing moves the hash instead of throwing', () => {
  // `git ls-files --cached` still lists an unstaged deletion, so the hash reads what is on disk. Without
  // that filter the coverage pass dies on `ENOENT` at the end of a real run.
  stamp();
  const before = stamp().workingTreeHash;

  fs.rmSync(path.join(repo, 'src/a.ts'));

  assert.notEqual(stamp().workingTreeHash, before);
});

test('renaming a file moves the hash, though its bytes travel unchanged', () => {
  stamp();
  const before = stamp().workingTreeHash;

  git('mv', 'src/a.ts', 'src/renamed.ts');

  assert.notEqual(stamp().workingTreeHash, before);
});

test('an ignored file is not part of the tree the stamp describes', () => {
  // Ignored files are what the run did not check out or write on purpose: build output, `coverage/`
  // itself, a developer's local scratch. Including them would make the stamp move under every build.
  const before = stamp().workingTreeHash;

  write('dist/built.js', 'module.exports = 1;\n');
  write('coverage/lcov.info', 'TN:\n');

  assert.equal(stamp().workingTreeHash, before);
});

test('an untracked file is part of the tree the stamp describes', () => {
  // A new source file with no test yet is the exact state a verdict must not answer for from an old map,
  // and `--exclude-standard` keeps it in the list precisely because it is not ignored.
  const before = stamp().workingTreeHash;

  write('src/untracked.ts', 'export const untracked = 1;\n');

  assert.notEqual(stamp().workingTreeHash, before);
});

test('a dot-prefixed file is hashed like any other path', () => {
  write('src/.hidden.ts', 'export const hidden = 1;\n');
  const before = stamp().workingTreeHash;

  write('src/.hidden.ts', 'export const hidden = 2;\n');

  assert.notEqual(stamp().workingTreeHash, before);
});

test('a checkout with no commit is refused by name', () => {
  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-stamp-empty-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: orphan });
    assert.throws(() => beginCoverageRun(orphan), /no commit/);
  } finally {
    fs.rmSync(orphan, { recursive: true, force: true });
  }
});

test('a file written while the run was in progress keeps the pass from stamping at all', () => {
  // The defect the pair exists for: a pass takes minutes, and an edit half way through means the reports
  // describe a tree that no longer exists. Hashing only at the end would stamp the edited tree and then
  // read back clean against it, which is the false trust this record has to make unrepresentable.
  const run = beginCoverageRun(repo);

  write('src/a.ts', 'export const a = 2;\n');

  assert.deepEqual(finish(run), { moved: true });
  assert.equal(stampOnDisk(), null);
});

test('a commit made while the run was in progress keeps the pass from stamping too', () => {
  // Moving HEAD changes which map a verdict is entitled to build, and the pass read the parent's tree.
  const run = beginCoverageRun(repo);

  write('src/a.ts', 'export const a = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'mid-run');

  assert.deepEqual(finish(run), { moved: true });
});

test('a pass that cannot attest its reports writes nothing and deletes nothing', () => {
  // The writer's own contract: refusing is a decision to add no record, not to remove one. Which stamp is
  // on disk when a pass ends is Vitest's doing, not this file's — the provider wipes the reports directory
  // before a pass writes, so a record here can only ever belong to the reports beside it.
  const earlier = stamp();
  const run = beginCoverageRun(repo);

  write('src/a.ts', 'export const a = 2;\n');

  assert.deepEqual(finish(run), { moved: true });
  assert.deepEqual(stampOnDisk(), earlier);
});

test('an edit reverted before the pass ends is the limit of hashing both ends', () => {
  // Stated as a boundary, not a claim of detection: the pass loaded the edited bytes, and the tree it ends
  // on is the tree it began on, so a content hash taken at both ends agrees and the stamp stands. Closing
  // this would mean comparing the modules the workers actually imported. What the pair does guard is the
  // ordinary case — an edit left in place, which is what editing during a three-minute pass produces.
  const before = stamp().workingTreeHash;
  const run = beginCoverageRun(repo);

  write('src/a.ts', 'export const a = 2;\n');
  write('src/a.ts', 'export const a = 1;\n');
  const outcome = finish(run);

  assert.ok('written' in outcome);
  assert.equal(outcome.written.workingTreeHash, before);
});

test('the stamp records the commit, the tree, and the run that wrote it', () => {
  const written = stamp();

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, STAMP_PATH), 'utf8')), written);
  assert.equal(written.schemaVersion, 1);
  assert.equal(written.head, git('rev-parse', 'HEAD'));
  assert.match(written.workingTreeHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(written.runSelection, 'full');
  assert.deepEqual(written.include, ['src/**/*.ts']);
  assert.deepEqual(written.exclude, ['src/generated/**']);
});
