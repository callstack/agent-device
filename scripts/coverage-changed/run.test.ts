import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { run } from './run.ts';
import {
  beginCoverageRun,
  finishCoverageRun,
  type CoverageConfig,
  type RunSelection,
} from '../coverage-crap/stamp.ts';
import { beginStderrCapture, beginStdoutCapture } from '@agent-device/test-kit';

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

function write(rel: string, content: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writeLcov(records: string): void {
  write('coverage/lcov.info', records);
}

/**
 * What the fixture's coverage pass was told to instrument. Mirrors the
 * `test.coverage` include/exclude in `vitest.config.ts` for the paths these
 * tests exercise: both coverage roots, test files out, `src/sdk/**` out.
 */
const COVERAGE_CONFIG: CoverageConfig = {
  include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
  exclude: [
    '**/*.test.ts',
    '**/__tests__/**',
    '**/*-types.ts',
    '**/types.ts',
    'src/sdk/**',
    'src/bin.ts',
  ],
};

/** What `pnpm test:coverage` leaves beside its reports: the stamp naming the run that wrote them. */
function writeStamp(runSelection: RunSelection = 'full'): void {
  const outcome = finishCoverageRun(
    beginCoverageRun(repo),
    path.join(repo, 'coverage'),
    COVERAGE_CONFIG,
    runSelection,
  );
  assert.ok(
    'written' in outcome,
    'expected a pass over an unmoved fixture tree to write its stamp',
  );
}

// Redirect the module's stdout/stderr writers so the entrypoint's rendering
// runs without spamming the test reporter.
function capture(fn: () => number): { code: number; out: string } {
  const stdoutCapture = beginStdoutCapture();
  const stderrCapture = beginStderrCapture();
  try {
    const code = fn();
    return { code, out: stdoutCapture.read() + stderrCapture.read() };
  } finally {
    stdoutCapture.restore();
    stderrCapture.restore();
  }
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-changed-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('checkout', '-q', '-b', 'main');
  // Same as this repository's own ignore rules: the reports and the stamp beside them live outside the
  // tree the stamp describes, which is what lets writing them leave the hash it just computed alone.
  write('.gitignore', 'coverage/\n');
  write('src/base.ts', 'export const base = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

test('passes and prints n/a for a docs-only change without touching coverage', () => {
  write('README.md', '# hello\nnew docs line\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'docs');
  writeLcov('SF:src/base.ts\nDA:1,1\nend_of_record\n');
  writeStamp();
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 0);
  assert.match(out, /Changed-line coverage gate: PASS/);
  assert.match(out, /0\/0 \(n\/a\)/);
});

test('a committed symlink to a directory passes the gate without an EISDIR crash', () => {
  // The object mode in the diff header is what keeps a committed symlink (target recorded
  // as one added line, a directory in the working tree) out of the content read below.
  fs.mkdirSync(path.join(repo, 'vendor'), { recursive: true });
  write('vendor/keep.txt', 'not source\n');
  // Shaped like instrumented source so the gate reaches its content read; what stands
  // behind the name is a directory.
  fs.symlinkSync('../vendor', path.join(repo, 'src/linked.ts'));
  write('README.md', '# docs\nnew line\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'symlink into a directory and docs');
  writeLcov('SF:src/base.ts\nDA:1,1\nend_of_record\n');
  writeStamp();

  const { code, out } = capture(() => run(['--base', 'main'], repo));

  assert.equal(code, 0);
  assert.match(out, /Changed-line coverage gate: PASS/);
});

test('reads a large stacked diff beyond the subprocess default buffer', () => {
  write('README.md', '# large stack\n' + 'documentation line\n'.repeat(80_000));
  git('add', '-A');
  git('commit', '-q', '-m', 'large docs stack');
  writeLcov('SF:src/base.ts\nDA:1,1\nend_of_record\n');
  writeStamp();

  const { code, out } = capture(() => run(['--base', 'main'], repo));

  assert.equal(code, 0);
  assert.match(out, /Changed-line coverage gate: PASS/);
  assert.match(out, /0\/0 \(n\/a\)/);
});

test('fails when a changed source line is uncovered and names that line', () => {
  write('src/feature.ts', 'export const covered = 1;\nexport const uncovered = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  writeLcov('SF:src/feature.ts\nDA:1,3\nDA:2,0\nend_of_record\n');
  writeStamp();
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 1);
  assert.match(out, /Changed-line coverage gate: FAIL/);
  assert.match(out, /`src\/feature\.ts`: 2/);
});

test('a changed line in a non-ASCII path is scored, not skipped by quoted diff headers', () => {
  write('src/café.ts', 'export const covered = 1;\nexport const uncovered = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'non-ascii path');
  writeLcov('SF:src/café.ts\nDA:1,3\nDA:2,0\nend_of_record\n');
  writeStamp();
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 1);
  assert.match(out, /`src\/café\.ts`: 2/);
});

test('fails when a changed workspace package line is uncovered and names that line', () => {
  write(
    'packages/contracts/src/feature.ts',
    'export const covered = 1;\nexport const uncovered = 2;\n',
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'package feature');
  writeLcov('SF:packages/contracts/src/feature.ts\nDA:1,3\nDA:2,0\nend_of_record\n');
  writeStamp();
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 1);
  assert.match(out, /Changed-line coverage gate: FAIL/);
  assert.match(out, /`packages\/contracts\/src\/feature\.ts`: 2/);
});

test('waiver env keeps the job green, still reporting numbers to the job summary', () => {
  write('src/feature.ts', 'export const covered = 1;\nexport const uncovered = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  writeLcov('SF:src/feature.ts\nDA:1,3\nDA:2,0\nend_of_record\n');
  writeStamp();
  const summaryPath = path.join(repo, 'summary.md');
  const previous = {
    waiver: process.env.AGENT_DEVICE_COVERAGE_WAIVER,
    summary: process.env.GITHUB_STEP_SUMMARY,
  };
  process.env.AGENT_DEVICE_COVERAGE_WAIVER = 'true';
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  try {
    const { code, out } = capture(() => run(['--base', 'main'], repo));
    assert.equal(code, 0);
    assert.match(out, /WAIVED/);
    assert.match(out, /1\/2/);
    const summary = fs.readFileSync(summaryPath, 'utf8');
    assert.match(summary, /## Changed-line coverage gate/);
    assert.match(summary, /Changed-branch coverage \(non-gating\)/);
    assert.match(summary, /Changed executable lines excluded/);
  } finally {
    if (previous.waiver === undefined) delete process.env.AGENT_DEVICE_COVERAGE_WAIVER;
    else process.env.AGENT_DEVICE_COVERAGE_WAIVER = previous.waiver;
    if (previous.summary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previous.summary;
  }
});

test('errors when the lcov report is missing rather than silently passing', () => {
  write('src/feature.ts', 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 1);
  assert.match(out, /no lcov report/);
});

test('a pure move owes nothing regardless of the host diff.renames setting', () => {
  git('config', 'diff.renames', 'false');
  git('mv', 'src/base.ts', 'src/moved.ts');
  git('commit', '-q', '-m', 'move');
  writeLcov('SF:src/moved.ts\nDA:1,0\nend_of_record\n');
  writeStamp();
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 0);
  assert.match(out, /Changed-line coverage gate: PASS/);
  assert.match(out, /0\/0 \(n\/a\)/);
});

test('a valid stamp keeps the clean report behavior', () => {
  write('src/feature.ts', 'export const covered = 1;\nexport const alsoCovered = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  writeLcov('SF:src/feature.ts\nDA:1,3\nDA:2,1\nend_of_record\n');
  writeStamp();
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 0);
  assert.match(out, /Changed-line coverage gate: PASS/);
  assert.match(out, /2\/2 \(100\.00%\)/);
});

test('refuses a report with no stamp beside it instead of scoring it', () => {
  write('src/feature.ts', 'export const covered = 1;\nexport const uncovered = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  writeLcov('SF:src/feature.ts\nDA:1,3\nDA:2,0\nend_of_record\n');
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/);
  assert.match(out, /carries no coverage-run-stamp\.json/);
  assert.doesNotMatch(out, /Changed-line coverage gate:/);
});

test('refuses a report whose stamp names an earlier commit', () => {
  write('src/feature.ts', 'export const covered = 1;\nexport const uncovered = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  writeLcov('SF:src/feature.ts\nDA:1,3\nDA:2,0\nend_of_record\n');
  writeStamp();
  // The stamp vouches for the tree coverage finished on, so committing after the run moves HEAD
  // under it and the report must not answer for the new commit.
  write('src/other.ts', 'export const other = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'later change');
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/);
  assert.match(out, /HEAD moved since the coverage run wrote its stamp/);
  assert.doesNotMatch(out, /Changed-line coverage gate:/);
});

test('refuses a report whose tree was edited after the run instead of scoring it', () => {
  write('src/feature.ts', 'export const covered = 1;\nexport const uncovered = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  writeLcov('SF:src/feature.ts\nDA:1,3\nDA:2,0\nend_of_record\n');
  writeStamp();
  // HEAD has not moved, so only the tree hash can tell: the counters are real,
  // the code they measured is gone.
  write('src/feature.ts', 'export const covered = 1;\nexport const uncovered = 3;\n');
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/);
  assert.match(out, /this checkout changed since the coverage run wrote its stamp/);
  assert.doesNotMatch(out, /Changed-line coverage gate:/);
});

test('refuses a narrowed run stamp instead of scoring its partial map', () => {
  write('src/feature.ts', 'export const covered = 1;\nexport const uncovered = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  writeLcov('SF:src/feature.ts\nDA:1,3\nDA:2,0\nend_of_record\n');
  writeStamp('files');
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/);
  assert.match(out, /did not exercise the whole coverage lane/);
  assert.doesNotMatch(out, /Changed-line coverage gate:/);
});

test('refuses a report written in another checkout instead of passing it as clean', () => {
  write('src/feature.ts', 'export const covered = 1;\nexport const uncovered = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  // Two checkouts of one commit share HEAD and bytes, so no stamp can tell them apart: the lcov
  // paths themselves must name the foreign root. A map like this joins none of this checkout's
  // files, which without the check reads as "no file was measured" and passes 0/0.
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-changed-foreign-'));
  try {
    writeLcov(`SF:${foreign}/src/feature.ts\nDA:1,3\nDA:2,0\nend_of_record\n`);
    const { code, out } = capture(() => run(['--base', 'main'], repo));
    assert.equal(code, 1);
    assert.match(out, /no trustworthy verdict/);
    assert.match(out, /records files outside this checkout/);
    assert.doesNotMatch(out, /Changed-line coverage gate:/);
  } finally {
    fs.rmSync(foreign, { recursive: true, force: true });
  }
});

test('a file the stamp excludes is out of scope, not tallied as excluded', () => {
  write('src/sdk/thing.ts', 'export const kept = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'sdk change');
  // No record for it in lcov: the run never measured it, by declaration. The
  // gate owes nothing for it — neither a denominator line nor a tally entry.
  writeLcov('SF:src/base.ts\nDA:1,1\nend_of_record\n');
  writeStamp();
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 0);
  assert.match(out, /Changed-line coverage gate: PASS/);
  assert.match(out, /0\/0 \(n\/a\)/);
  assert.match(out, /Changed executable lines excluded \(non-gating\) \| 0 \|/);
});
