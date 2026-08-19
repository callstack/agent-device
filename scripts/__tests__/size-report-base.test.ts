import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { runCmd, runCmdSync } from '../../src/utils/exec.ts';

// `pnpm size --base <ref>` orchestration against a throwaway git repository, with `pnpm` and
// `npm` shimmed on PATH: the shim `pnpm build` writes dist/src and appends to a log, the shim
// `npm pack` prints a fixed dry-run JSON. No install, no network; every run is git + node.
//
// This file owns what only real processes can show: that two concurrent runs build once, that a
// cached entry is reused, and that eviction respects a claim. The claim protocol's own
// interleavings (takeover, replacement, contention) are planted directly in
// size-base-cache.test.ts, which needs no subprocess at all.

const ROOT = path.join(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'size-report.mjs');
const NEVER_A_PID = 2_147_483_647; // outside every platform's pid range: dead by construction

let repo: string;
let bin: string;
let buildLog: string;
let first: string;
let second: string;

function git(args: string[], cwd = repo): string {
  return runCmdSync('git', args, { cwd }).stdout.trim();
}

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

beforeAll(() => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'size-report-base-'));
  repo = path.join(scratch, 'repo');
  bin = path.join(scratch, 'bin');
  buildLog = path.join(scratch, 'build.log');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  writeExecutable(
    path.join(bin, 'pnpm'),
    `#!/bin/sh
echo "$PWD $*" >> "${buildLog}"
if [ "$1" = "build" ]; then mkdir -p dist/src && printf 'export const built = 1;\\n' > dist/src/index.js; fi
`,
  );
  writeExecutable(
    path.join(bin, 'npm'),
    `#!/bin/sh
echo '[{"filename":"pkg.tgz","size":100,"unpackedSize":200,"entryCount":2}]'
`,
  );
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'size@test']);
  git(['config', 'user.name', 'size test']);
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"probe","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.tmp/\ndist/\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'first']);
  first = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'second\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'second']);
  second = git(['rev-parse', 'HEAD']);
  // The head side of the comparison needs a dist too.
  fs.mkdirSync(path.join(repo, 'dist', 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'dist', 'src', 'index.js'), 'export const head = 1;\n');
});

afterAll(() => {
  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
});

async function size(base: string) {
  return await runCmd(process.execPath, [SCRIPT, '--cwd', repo, '--base', base], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    allowFailure: true,
    timeoutMs: 60_000,
  });
}

const worktreeOf = (sha: string) => path.join(repo, '.tmp', 'size-base', sha.slice(0, 12));
const lockOf = (sha: string) => `${worktreeOf(sha)}.lock`;
const holdLock = (sha: string, pid: number) => fs.symlinkSync(`${pid}:test`, lockOf(sha));
const stampOf = (sha: string) => path.join(worktreeOf(sha), 'dist', '.size-base-complete');
const builds = () =>
  fs
    .readFileSync(buildLog, 'utf8')
    .split('\n')
    .filter((l) => l.endsWith(' build'));

test('first run builds the base in a per-SHA worktree, stamps it, releases its lock; second run reuses it', async () => {
  const one = await size(first);
  assert.equal(one.exitCode, 0, one.stderr);
  assert.match(one.stdout, /\| JS raw \|/);
  assert.ok(fs.existsSync(stampOf(first)), 'completion stamp written after build');
  assert.equal(fs.existsSync(lockOf(first)), false, 'lock released after the report was read');
  assert.equal(builds().length, 1);

  const two = await size(first);
  assert.equal(two.exitCode, 0, two.stderr);
  assert.equal(builds().length, 1, 'a stamped base is not rebuilt');
});

test('a base whose lock is held by a live pid fails fast without touching its worktree', async () => {
  holdLock(first, process.pid); // this test process: alive
  const before = fs.statSync(stampOf(first)).mtimeMs;
  const result = await size(first);
  assert.notEqual(result.exitCode, 0);
  assert.match(
    result.stderr,
    new RegExp(`another \`size --base\` \\(pid ${process.pid}\\) is using`),
  );
  assert.equal(fs.statSync(stampOf(first)).mtimeMs, before);
  assert.equal(builds().length, 1);
  fs.rmSync(lockOf(first));
});

test('a stale lock (dead pid) is replaced and the run proceeds', async () => {
  holdLock(first, NEVER_A_PID);
  const result = await size(first);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.existsSync(lockOf(first)), false);
});

test('an unstamped worktree (interrupted build) is rebuilt rather than trusted', async () => {
  fs.rmSync(stampOf(first));
  const result = await size(first);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(builds().length, 2, 'dist/src existing without the stamp is not enough');
  assert.ok(fs.existsSync(stampOf(first)));
});

test('measuring another base evicts an idle cached base but never one whose lock is live', async () => {
  holdLock(first, process.pid); // in use by "another run"
  const guarded = await size(second);
  assert.equal(guarded.exitCode, 0, guarded.stderr);
  assert.ok(fs.existsSync(worktreeOf(first)), 'a live-locked worktree survives eviction');
  assert.ok(fs.existsSync(stampOf(second)));
  fs.rmSync(lockOf(first));

  const evicting = await size(first);
  assert.equal(evicting.exitCode, 0, evicting.stderr);
  assert.equal(fs.existsSync(worktreeOf(second)), false, 'an idle other base is evicted');
  assert.equal(
    git(['worktree', 'list', '--porcelain']).includes(worktreeOf(second)),
    false,
    'and unregistered from git',
  );
});

test('two overlapping runs on the same base: exactly one builds, the other fails fast on the live lock', async () => {
  // A slower shim build widens the overlap window: the second run must find the first run's
  // symlink lock (identity in place from its single creating syscall) and refuse.
  fs.rmSync(worktreeOf(first), { recursive: true, force: true });
  runCmdSync('git', ['worktree', 'prune'], { cwd: repo });
  fs.rmSync(stampOf(first), { force: true });
  const slowBin = path.join(path.dirname(bin), 'slow-bin');
  fs.mkdirSync(slowBin, { recursive: true });
  writeExecutable(
    path.join(slowBin, 'pnpm'),
    `#!/bin/sh
echo "$PWD $*" >> "${buildLog}"
if [ "$1" = "build" ]; then sleep 1; mkdir -p dist/src && printf 'export const built = 1;\\n' > dist/src/index.js; fi
`,
  );
  fs.copyFileSync(path.join(bin, 'npm'), path.join(slowBin, 'npm'));
  fs.chmodSync(path.join(slowBin, 'npm'), 0o755);
  const buildsBefore = builds().length;
  const env = { ...process.env, PATH: `${slowBin}:${process.env.PATH ?? ''}` };
  const run = () =>
    runCmd(process.execPath, [SCRIPT, '--cwd', repo, '--base', first], {
      cwd: repo,
      env,
      allowFailure: true,
      timeoutMs: 60_000,
    });
  const [a, b] = await Promise.all([run(), run()]);
  const outcomes = [a, b].map((r) => r.exitCode === 0);
  assert.deepEqual(
    outcomes.sort(),
    [false, true],
    `one wins, one refuses: ${a.stderr} ${b.stderr}`,
  );
  const loser = a.exitCode === 0 ? b : a;
  assert.match(loser.stderr, /another `size --base` \(pid \d+\) is using base/);
  assert.equal(builds().length - buildsBefore, 1, 'exactly one build across the two runs');
  assert.ok(fs.existsSync(stampOf(first)));
  assert.equal(
    fs.existsSync(lockOf(first)),
    false,
    'the winner released; the loser removed nothing',
  );
});
