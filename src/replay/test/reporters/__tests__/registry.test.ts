import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ReplaySuiteResult } from '../../../../contracts/replay.ts';
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
