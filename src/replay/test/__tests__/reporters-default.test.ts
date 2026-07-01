import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ReplaySuiteResult } from '../../../daemon/types.ts';
import { createDefaultReplayTestReporter } from '../reporters/default.ts';
import type { ReplayTestReporterContext } from '../reporters/types.ts';

function createReporterContext(options: { stderrIsTty: boolean }): {
  context: ReplayTestReporterContext;
  stderr: string[];
  stdout: string[];
} {
  const stderr: string[] = [];
  const stdout: string[] = [];
  return {
    context: {
      stdout: {
        isTTY: false,
        write: (text) => stdout.push(text),
      },
      stderr: {
        isTTY: options.stderrIsTty,
        write: (text) => stderr.push(text),
      },
    },
    stderr,
    stdout,
  };
}

function emptySuite(): ReplaySuiteResult {
  return {
    total: 0,
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    notRun: 0,
    durationMs: 0,
    failures: [],
    tests: [],
  };
}

function withCiEnv<T>(value: string | undefined, run: () => T): T {
  const original = process.env.CI;
  if (value === undefined) delete process.env.CI;
  else process.env.CI = value;
  try {
    return run();
  } finally {
    if (original === undefined) delete process.env.CI;
    else process.env.CI = original;
  }
}

test('default replay test reporter hides and restores cursor for tty progress', () => {
  withCiEnv('0', () => {
    const reporter = createDefaultReplayTestReporter();
    const { context, stderr, stdout } = createReporterContext({ stderrIsTty: true });

    reporter.onSuiteStart?.(
      { total: 0, runnable: 0, skipped: 0, artifactsDir: '/tmp/replay' },
      context,
    );
    reporter.onSuiteEnd?.(emptySuite(), context);

    assert.equal(stderr[0], '\u001B[?25l');
    assert.equal(stderr.at(-1), '\u001B[?25h');
    assert.deepEqual(stdout, ['Test summary: 0 passed (0) in 0s\n']);
  });
});

test('default replay test reporter leaves cursor alone for non-tty streams', () => {
  const reporter = createDefaultReplayTestReporter();
  const { context, stderr } = createReporterContext({ stderrIsTty: false });

  reporter.onSuiteStart?.(
    { total: 0, runnable: 0, skipped: 0, artifactsDir: '/tmp/replay' },
    context,
  );
  reporter.onSuiteEnd?.(emptySuite(), context);

  assert.deepEqual(stderr, []);
});
