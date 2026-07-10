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
  withCiEnv(undefined, () => {
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

function failingSuiteWithDivergence(): ReplaySuiteResult {
  const failed = {
    file: '/tmp/flow.ad',
    title: 'checkout',
    session: 'test-session',
    status: 'failed' as const,
    durationMs: 10,
    attempts: 1,
    error: {
      code: 'REPLAY_DIVERGENCE',
      message: 'Replay failed at step 2 (click "Save"): not hittable',
      details: {
        divergence: {
          version: 1,
          kind: 'action-failure',
          step: { index: 2, source: { path: '/tmp/flow.ad', line: 2 } },
          action: 'click "Save"',
          cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
          screen: {
            state: 'available',
            refsGeneration: 4,
            refs: [{ ref: 'e5', role: 'button', label: 'Save' }],
          },
          suggestions: [
            { selector: 'id="save"', basis: 'id', ref: 'e5', role: 'button', label: 'Save' },
          ],
          suggestionCount: 1,
          resume: { allowed: false, reason: 'resume not yet supported' },
        },
      },
    },
  };
  return {
    total: 1,
    executed: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
    notRun: 0,
    durationMs: 10,
    failures: [failed],
    tests: [failed],
  };
}

test('default replay test reporter surfaces the divergence repair report on a failure', () => {
  const reporter = createDefaultReplayTestReporter();
  const { context, stdout } = createReporterContext({ stderrIsTty: false });
  reporter.onSuiteEnd?.(failingSuiteWithDivergence(), context);
  const out = stdout.join('');
  // The test text surface must carry the same repair data as --json.
  assert.match(out, /Divergence at step 2 \(\/tmp\/flow\.ad:2\)/);
  assert.match(out, /Screen: 1 actionable ref\(s\) captured \(refsGeneration 4\)/);
  assert.match(out, /@e5 \[button\] "Save"/);
  assert.match(out, /Suggestions:/);
  assert.match(out, /\[id\] "Save" id="save"/);
});
