import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import {
  getReplayTestReporterExitCode,
  runReplayTestReporterProgress,
  runReplayTestReporters,
} from '../registry.ts';
import type { ReplayTestReporter, ReplayTestReporterContext } from '../types.ts';

const context: ReplayTestReporterContext = {
  stdout: { isTTY: false, write() {} },
  stderr: { isTTY: false, write() {} },
};

function createRecordingContext(): {
  context: ReplayTestReporterContext;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    context: {
      stdout: { isTTY: false, write: (text) => stdout.push(text) },
      stderr: { isTTY: false, write: (text) => stderr.push(text) },
    },
    stdout,
    stderr,
  };
}

function suite(failed = 0): ReplaySuiteResult {
  return {
    total: 1,
    executed: 1,
    passed: failed === 0 ? 1 : 0,
    failed,
    skipped: 0,
    notRun: 0,
    durationMs: 1,
    failures: [],
    tests: [],
  };
}

test('runs live hooks in reporter order and awaits final hooks sequentially', async () => {
  const calls: string[] = [];
  const reporters: ReplayTestReporter[] = [
    {
      name: 'first',
      onTestResult() {
        calls.push('first:live');
      },
      async onSuiteEnd() {
        calls.push('first:end:start');
        await Promise.resolve();
        calls.push('first:end:done');
      },
    },
    {
      name: 'second',
      onTestResult() {
        calls.push('second:live');
      },
      onSuiteEnd() {
        calls.push('second:end');
      },
    },
  ];

  runReplayTestReporterProgress(
    reporters,
    {
      type: 'replay-test',
      file: '/tmp/flow.ad',
      status: 'pass',
      index: 1,
      total: 1,
      durationMs: 1,
    },
    context,
  );
  await runReplayTestReporters(reporters, suite(), context);

  assert.deepEqual(calls, [
    'first:live',
    'second:live',
    'first:end:start',
    'first:end:done',
    'second:end',
  ]);
});

test('isolates thrown live-hook failures so later reporters and final rendering continue', async () => {
  const output = createRecordingContext();
  const calls: string[] = [];
  const reporters: ReplayTestReporter[] = [
    {
      name: 'throwing',
      onTestResult() {
        calls.push('throwing:live');
        throw new Error('sync boom');
      },
    },
    {
      name: 'renderer',
      onTestResult(_test, reporterContext) {
        calls.push('renderer:live');
        reporterContext.stdout.write('live rendered\n');
      },
      onSuiteEnd(_suite, reporterContext) {
        calls.push('renderer:end');
        reporterContext.stdout.write('final rendered\n');
      },
    },
  ];

  runReplayTestReporterProgress(
    reporters,
    {
      type: 'replay-test',
      file: '/tmp/flow.ad',
      status: 'pass',
      index: 1,
      total: 1,
      durationMs: 1,
    },
    output.context,
  );
  await runReplayTestReporters(reporters, suite(), output.context);

  assert.deepEqual(calls, ['throwing:live', 'renderer:live', 'renderer:end']);
  assert.deepEqual(output.stdout, ['live rendered\n', 'final rendered\n']);
  assert.deepEqual(output.stderr, ['Reporter throwing onTestResult failed: sync boom\n']);
});

test('reports rejected live hooks and never awaits pending live promises', async () => {
  const output = createRecordingContext();
  const calls: string[] = [];
  let resolvePending!: () => void;
  const pending = new Promise<void>((resolve) => {
    resolvePending = resolve;
  });
  const reporters: ReplayTestReporter[] = [
    {
      name: 'rejecting',
      onTestResult() {
        calls.push('rejecting:live');
        return Promise.reject(new Error('async boom'));
      },
    },
    {
      name: 'pending',
      onTestResult() {
        calls.push('pending:live');
        return pending;
      },
    },
    {
      name: 'later',
      onTestResult() {
        calls.push('later:live');
      },
      onSuiteEnd() {
        calls.push('later:end');
      },
    },
  ];

  runReplayTestReporterProgress(
    reporters,
    {
      type: 'replay-test',
      file: '/tmp/flow.ad',
      status: 'pass',
      index: 1,
      total: 1,
      durationMs: 1,
    },
    output.context,
  );

  assert.deepEqual(calls, ['rejecting:live', 'pending:live', 'later:live']);
  await Promise.resolve();
  await Promise.resolve();
  await runReplayTestReporters(reporters, suite(), output.context);
  assert.deepEqual(calls, ['rejecting:live', 'pending:live', 'later:live', 'later:end']);
  assert.deepEqual(output.stderr, ['Reporter rejecting onTestResult failed: async boom\n']);
  resolvePending();
});

// #1478 P3 characterization: live hooks are isolated (above), final hooks are not. A throwing
// `onSuiteEnd` propagates out of suite completion and skips the reporters after it. Pinned as
// shipped so the extraction cannot quietly start swallowing it.
test('a throwing onSuiteEnd propagates and stops later reporters from finishing', async () => {
  const calls: string[] = [];
  const reporters: ReplayTestReporter[] = [
    {
      name: 'throwing-end',
      onSuiteEnd() {
        calls.push('throwing-end');
        throw new Error('final boom');
      },
    },
    {
      name: 'later',
      onSuiteEnd() {
        calls.push('later:end');
      },
    },
  ];

  await assert.rejects(runReplayTestReporters(reporters, suite(), context), /final boom/);
  assert.deepEqual(calls, ['throwing-end']);
});

test('getExitCode sees the same suite value onSuiteEnd received', async () => {
  const seen: ReplaySuiteResult[] = [];
  const value = suite(2);
  const reporters: ReplayTestReporter[] = [
    {
      name: 'observer',
      onSuiteEnd: (endSuite) => void seen.push(endSuite),
      getExitCode: (exitSuite) => {
        seen.push(exitSuite);
        return undefined;
      },
    },
  ];

  await runReplayTestReporters(reporters, value, context);
  const exitCode = getReplayTestReporterExitCode(reporters, value);

  assert.equal(seen.length, 2);
  assert.equal(seen[0], value);
  assert.equal(seen[1], value);
  // Two failures still recommend the shipped generic failure exit code, not a failure count.
  assert.equal(exitCode, 1);
});

test('reporter exit codes can raise but never lower the suite exit code', () => {
  const reporters: ReplayTestReporter[] = [
    { name: 'lower', getExitCode: () => 0 },
    { name: 'higher', getExitCode: () => 3 },
    { name: 'absent', getExitCode: () => undefined },
  ];

  assert.equal(getReplayTestReporterExitCode(reporters, suite(1)), 3);
  assert.equal(
    getReplayTestReporterExitCode([{ name: 'lower', getExitCode: () => 0 }], suite(1)),
    1,
  );
});
