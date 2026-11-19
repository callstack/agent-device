import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { escapeTerminalText } from '@agent-device/kernel/redaction';
import assert from 'node:assert/strict';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import { createDefaultReplayTestReporter, readCommandProgressWriter } from '../default.ts';
import type { ReplayTestReporterContext } from '../types.ts';

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

function withEnv<T>(name: 'CI' | 'TMUX', value: string | undefined, run: () => T): T {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

test('default replay test reporter hides and restores cursor for tty progress', () => {
  withEnv('CI', undefined, () => {
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

test('default replay test reporter avoids cursor-up cleanup inside tmux', () => {
  withEnv('CI', undefined, () =>
    withEnv('TMUX', '/tmp/tmux-1000/default,1,0', () => {
      const reporter = createDefaultReplayTestReporter();
      const { context, stderr } = createReporterContext({ stderrIsTty: true });
      context.stderr.columns = 200;
      reporter.onSuiteStart?.(
        { total: 1, runnable: 1, skipped: 0, artifactsDir: '/tmp/replay' },
        context,
      );
      reporter.onTestStep?.(
        {
          file: '/tmp/checkout.yaml',
          title: 'x'.repeat(180),
          index: 1,
          total: 1,
          stepIndex: 1,
          stepTotal: 2,
          stepCommand: 'assertVisible',
          stepValue: 'Confirmation',
        },
        context,
      );

      context.stderr.columns = 20;
      reporter.onTestStep?.(
        {
          file: '/tmp/checkout.yaml',
          title: 'Checkout',
          index: 1,
          total: 1,
          stepIndex: 2,
          stepTotal: 2,
          stepCommand: 'tapOn',
          stepValue: 'Continue',
        },
        context,
      );
      reporter.onSuiteEnd?.(emptySuite(), context);

      const resizedProgress = stderr[2];
      assert.equal((resizedProgress?.split('\u001B[1A').length ?? 1) - 1, 0);
      assert.equal((resizedProgress?.split('\u001B[2K').length ?? 1) - 1, 1);
    }),
  );
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

function failingSuiteWithWarnings(): ReplaySuiteResult {
  const failed = {
    file: '/tmp/flow.yaml',
    title: 'sign-in',
    session: 'test-session',
    status: 'failed' as const,
    durationMs: 10,
    attempts: 1,
    warnings: ['Optional Maestro assertVisible skipped at /tmp/flow.yaml:line 3: sheet owns focus'],
    error: { code: 'COMMAND_FAILED', message: 'tapOn Save did not resolve' },
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

function passingSuiteWithWarnings(): ReplaySuiteResult {
  const passed = {
    file: '/tmp/flow.yaml',
    title: 'sign-in',
    session: 'test-session',
    status: 'passed' as const,
    durationMs: 20,
    attempts: 1,
    replayed: 3,
    healed: 0,
    warnings: ['Optional Maestro tapOn skipped at /tmp/flow.yaml:line 12: target did not resolve'],
  };
  return {
    total: 1,
    executed: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    notRun: 0,
    durationMs: 20,
    failures: [],
    tests: [passed],
  };
}

test('default replay test reporter surfaces per-test warnings on a passing suite (#2560)', () => {
  const reporter = createDefaultReplayTestReporter();
  const { context, stdout } = createReporterContext({ stderrIsTty: false });
  reporter.onSuiteEnd?.(passingSuiteWithWarnings(), context);
  const out = stdout.join('');
  assert.match(out, /Warnings:\n/);
  assert.match(out, /sign-in.*warning: Optional Maestro tapOn skipped at \/tmp\/flow\.yaml/s);
});

test('default replay test reporter omits the warnings section without warnings', () => {
  const reporter = createDefaultReplayTestReporter();
  const { context, stdout } = createReporterContext({ stderrIsTty: false });
  reporter.onSuiteEnd?.(emptySuite(), context);
  assert.equal(stdout.join('').includes('Warnings:'), false);
});

test('default replay test reporter surfaces warnings accumulated before a failure (#2560)', () => {
  const reporter = createDefaultReplayTestReporter();
  const { context, stdout } = createReporterContext({ stderrIsTty: false });
  reporter.onSuiteEnd?.(failingSuiteWithWarnings(), context);
  const out = stdout.join('');
  assert.match(out, /Warnings:\n/);
  assert.match(
    out,
    /sign-in.*warning: Optional Maestro assertVisible skipped at .*sheet owns focus/s,
  );
});

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

/** The characters the CLI writer would escape, by the writer's own rule. */
function rawControls(text: string): string[] {
  return [...text].filter((char) => escapeTerminalText(char) !== char);
}

test('default replay test reporter escapes daemon-supplied text in its summary', () => {
  const reporter = createDefaultReplayTestReporter();
  const { context, stdout } = createReporterContext({ stderrIsTty: false });
  const failed = {
    file: '/tmp/flow.ad',
    title: 'checkout \u001b[8mhidden\u009b',
    session: 'test-session',
    status: 'failed' as const,
    durationMs: 10,
    attempts: 1,
    error: { code: 'COMMAND_FAILED', message: 'boom \u001b[2J' },
  };

  reporter.onSuiteEnd?.(
    {
      ...emptySuite(),
      total: 1,
      executed: 1,
      failed: 1,
      failures: [failed],
      tests: [failed],
    } as ReplaySuiteResult,
    context,
  );

  const out = stdout.join('');
  assert.ok(out.includes(String.raw`checkout \u001b[8mhidden\u009b`), out);
  assert.ok(out.includes(String.raw`boom \u001b[2J`), out);
  assert.deepEqual(rawControls(out), []);
});

test('default replay test reporter keeps a live row on one line and escapes its title', () => {
  withEnv('CI', undefined, () => {
    const reporter = createDefaultReplayTestReporter();
    const { context, stderr } = createReporterContext({ stderrIsTty: true });
    context.stderr.columns = 200;
    reporter.onSuiteStart?.(
      { total: 1, runnable: 1, skipped: 0, artifactsDir: '/tmp/replay' },
      context,
    );
    reporter.onTestStep?.(
      {
        file: '/tmp/checkout.yaml',
        title: 'Check\nout \u001b[8mhidden',
        index: 1,
        total: 1,
        stepIndex: 1,
        stepTotal: 1,
        stepCommand: 'tapOn',
        stepValue: 'Continue',
      },
      context,
    );
    reporter.onSuiteEnd?.(emptySuite(), context);

    const live = stderr.find((text) => text.includes('Check')) ?? '';
    assert.ok(live.includes(String.raw`Check out \u001b[8mhidden`), live);
    assert.equal(live.includes('\n'), false);
    assert.equal(live.includes('\u001b[8m'), false);
  });
});

/** An artifacts root whose name holds DEL and a C1 character, with one failed step traced in attempt 1. */
function tracedArtifactsDir(): string {
  const root = mkdtempForTestSync('agent-device-trace-');
  const artifactsDir = path.join(root, 'arts\u007f\u009b');
  fs.mkdirSync(path.join(artifactsDir, 'attempt-1'), { recursive: true });
  fs.writeFileSync(
    path.join(artifactsDir, 'attempt-1', 'replay-timing.ndjson'),
    [
      { type: 'replay_action_start', step: 1, command: 'tap', positionals: ['Pay\u001b[8mnow'] },
      { type: 'replay_action_stop', step: 1, command: 'tap', ok: false, durationMs: 5 },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n'),
  );
  return artifactsDir;
}

test('default replay test reporter reads the trace through the raw artifacts path and escapes its lines', () => {
  const reporter = createDefaultReplayTestReporter();
  const { context, stdout } = createReporterContext({ stderrIsTty: false });
  context.debug = true;
  const failed = {
    file: '/tmp/flow.ad',
    title: 'checkout',
    session: 'test-session',
    status: 'failed' as const,
    durationMs: 10,
    attempts: 1,
    artifactsDir: tracedArtifactsDir(),
    error: { code: 'COMMAND_FAILED', message: 'boom' },
  };

  reporter.onSuiteEnd?.(
    {
      ...emptySuite(),
      total: 1,
      executed: 1,
      failed: 1,
      failures: [failed],
      tests: [failed],
    } as ReplaySuiteResult,
    context,
  );

  const out = stdout.join('');
  assert.ok(out.includes('steps:'), out);
  assert.ok(out.includes(String.raw`Pay\u001b[8mnow`), out);
  assert.deepEqual(rawControls(out), []);
});

test('default replay test reporter escapes verbose timing lines', () => {
  const reporter = createDefaultReplayTestReporter();
  const { context, stderr } = createReporterContext({ stderrIsTty: false });
  context.verbose = true;

  reporter.onTestResult?.(
    {
      file: '/tmp/flow.ad',
      title: 'checkout',
      status: 'pass',
      index: 1,
      total: 1,
      attempt: 1,
      durationMs: 10,
      artifactsDir: tracedArtifactsDir(),
    },
    context,
  );

  const out = stderr.join('');
  assert.ok(out.includes(String.raw`Pay\u001b[8mnow`), out);
  assert.deepEqual(rawControls(out), []);
});

test('default replay test reporter keeps every live-row field on one line', () => {
  withEnv('CI', undefined, () => {
    const reporter = createDefaultReplayTestReporter();
    const { context, stderr } = createReporterContext({ stderrIsTty: true });
    context.stderr.columns = 300;
    reporter.onSuiteStart?.(
      { total: 1, runnable: 1, skipped: 0, artifactsDir: '/tmp/replay' },
      context,
    );
    reporter.onTestStep?.(
      {
        file: '/tmp/checkout.yaml',
        title: 'Checkout '.repeat(10),
        index: 1,
        total: 1,
        stepIndex: 1,
        stepTotal: 1,
        stepCommand: 'tap\tOn',
        stepValue: 'Con\ntinue',
        shardIndex: 0,
        shardCount: 2,
        deviceName: 'Pixel\n9',
      },
      context,
    );
    reporter.onSuiteEnd?.(emptySuite(), context);

    const live = stderr.find((text) => text.includes('Checkout')) ?? '';
    assert.ok(live.includes('Con tinue'), live);
    assert.ok(live.includes('Pixel 9'), live);
    assert.ok(live.includes('tap On'), live);
    assert.equal(/[\n\t]/.test(live), false);
  });
});

test('default replay test reporter shows malformed daemon counters as placeholders', () => {
  withEnv('CI', undefined, () => {
    const reporter = createDefaultReplayTestReporter();
    const { context, stderr, stdout } = createReporterContext({ stderrIsTty: true });
    context.stderr.columns = 200;
    reporter.onSuiteStart?.(
      { total: 1, runnable: 1, skipped: 0, artifactsDir: '/tmp/replay' },
      context,
    );
    reporter.onTestStep?.(
      {
        file: '/tmp/checkout.yaml',
        title: 'Checkout',
        index: 1,
        total: 1,
        stepIndex: '\u001b[8m1' as unknown as number,
        stepTotal: Number.NaN,
        stepCommand: 'tapOn',
        shardIndex: -1,
      },
      context,
    );
    reporter.onSuiteEnd?.(
      {
        ...emptySuite(),
        passed: '\u001b[2J' as unknown as number,
        total: 1.5,
        failed: '9' as unknown as number,
        durationMs: Number.NaN,
      },
      context,
    );

    const live = stderr.find((text) => text.includes('Checkout')) ?? '';
    assert.ok(live.includes('?/?'), live);
    assert.equal(live.includes('\u001b[8m'), false);
    assert.equal(live.includes('[0/'), false);
    assert.equal(stdout[0], 'Test summary: ? passed (?), ? failed in ?\n');
  });
});

// After the terminal narrows, the drawn row wraps: the progress line clears every wrapped row, and a redraw that
// still counted the old row would move the cursor up over the progress line.
test.each([200, 20])(
  'a command progress line clears the drawn live row, and the next row starts fresh (then %i columns)',
  (columns) => {
    withEnv('CI', undefined, () => {
      const reporter = createDefaultReplayTestReporter();
      const { context, stderr } = createReporterContext({ stderrIsTty: true });
      context.stderr.columns = 200;
      const step = {
        file: '/tmp/checkout.yaml',
        title: 'Checkout',
        index: 1,
        total: 1,
        stepIndex: 1,
        stepTotal: 2,
        stepCommand: 'tapOn',
      };
      reporter.onSuiteStart?.(
        { total: 1, runnable: 1, skipped: 0, artifactsDir: '/tmp/replay' },
        context,
      );
      reporter.onTestStep?.(step, context);
      context.stderr.columns = columns;
      readCommandProgressWriter(reporter)?.('Uploading app.apk (10 B) via direct upload', context);
      reporter.onTestStep?.({ ...step, stepIndex: 2 }, context);
      reporter.onSuiteEnd?.(emptySuite(), context);

      const progressIndex = stderr.findIndex((text) => text.includes('Uploading'));
      const drawn = stripVTControlCharacters(
        stderr.find((text) => text.includes('Checkout')) ?? '',
      ).replaceAll('\r', '');
      const wrappedRows = Math.ceil(drawn.length / columns);
      assert.equal(wrappedRows > 1, columns < drawn.length, drawn);
      assert.equal(
        stderr[progressIndex],
        `\r\u001B[2K${'\u001B[1A\r\u001B[2K'.repeat(wrappedRows - 1)}Uploading app.apk (10 B) via direct upload\n`,
      );
      // The redraw clears only its own fresh row, never the progress line above it.
      const redraw = stderr[progressIndex + 1] ?? '';
      assert.ok(redraw.includes('2/2'), redraw);
      assert.equal(redraw.includes('\u001B[1A'), false);
    });
  },
);
