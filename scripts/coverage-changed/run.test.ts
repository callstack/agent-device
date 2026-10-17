import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { run } from './run.ts';
import {
  beginStderrCapture,
  beginStdoutCapture,
} from '../../src/__tests__/test-utils/stream-capture.ts';

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
  // Shaped like includable source so the gate reaches its content read; what stands
  // behind the name is a directory.
  fs.symlinkSync('../vendor', path.join(repo, 'src/linked.ts'));
  write('README.md', '# docs\nnew line\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'symlink into a directory and docs');
  writeLcov('SF:src/base.ts\nDA:1,1\nend_of_record\n');

  const { code, out } = capture(() => run(['--base', 'main'], repo));

  assert.equal(code, 0);
  assert.match(out, /Changed-line coverage gate: PASS/);
});

test('reads a large stacked diff beyond the subprocess default buffer', () => {
  write('README.md', '# large stack\n' + 'documentation line\n'.repeat(80_000));
  git('add', '-A');
  git('commit', '-q', '-m', 'large docs stack');
  writeLcov('SF:src/base.ts\nDA:1,1\nend_of_record\n');

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
  const { code, out } = capture(() => run(['--base', 'main'], repo));
  assert.equal(code, 0);
  assert.match(out, /Changed-line coverage gate: PASS/);
  assert.match(out, /0\/0 \(n\/a\)/);
});
