import { test } from 'vitest';
import assert from 'node:assert/strict';
import { formatReplayTestProgressEvent } from '../cli-test-progress.ts';
import type { RequestProgressEvent } from '../daemon/request-progress.ts';

function withStreamTty<T>(stream: NodeJS.WriteStream, isTTY: boolean, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  const mutableStream = stream as unknown as Record<string, unknown>;
  try {
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: isTTY });
    return run();
  } finally {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else delete mutableStream.isTTY;
  }
}

test('formatReplayTestProgressEvent suppresses replay suite start context', () => {
  const line = formatReplayTestProgressEvent({
    type: 'replay-test-suite',
    status: 'start',
    total: 4,
    runnable: 3,
    skipped: 1,
    artifactsDir: '/tmp/replay-suite',
    shardMode: 'split',
    shardCount: 2,
  });

  assert.equal(line, undefined);
});

test('formatReplayTestProgressEvent suppresses replay test start context', () => {
  const line = formatReplayTestProgressEvent({
    type: 'replay-test',
    file: '/tmp/auth-flow.yml',
    title: 'Authentication flow',
    status: 'start',
    index: 2,
    total: 5,
    session: 'maestro-test:test:suite:2:attempt-1',
    artifactsDir: '/tmp/replay-suite/auth-flow',
    shardIndex: 1,
    shardCount: 2,
    deviceId: 'E140A942-965C-4A92-AC63-F3B23756BE02',
  });

  assert.equal(line, undefined);
});

test('formatReplayTestProgressEvent ignores unknown progress event types', () => {
  const line = formatReplayTestProgressEvent({
    type: 'future-progress-event',
    status: 'start',
  } as unknown as RequestProgressEvent);

  assert.equal(line, undefined);
});

test('formatReplayTestProgressEvent renders pass, retry, fail, and skip cases', () => {
  const cases: Array<{ event: RequestProgressEvent; expected: RegExp }> = [
    {
      event: {
        type: 'replay-test',
        file: '/tmp/01-login.ad',
        status: 'pass',
        index: 1,
        total: 3,
        attempt: 2,
        maxAttempts: 2,
        durationMs: 12_345,
      },
      expected: /^✓ 01-login\.ad \(12\.3s\)$/,
    },
    {
      event: {
        type: 'replay-test',
        file: '/tmp/02-checkout.ad',
        status: 'fail',
        index: 2,
        total: 3,
        attempt: 1,
        maxAttempts: 2,
        durationMs: 1_234,
        retrying: true,
        message: 'first attempt failed',
      },
      expected: /^$/,
    },
    {
      event: {
        type: 'replay-test',
        file: '/tmp/03-payment.ad',
        status: 'fail',
        index: 3,
        total: 3,
        attempt: 2,
        maxAttempts: 2,
        durationMs: 9_876,
        message: 'assertVisible failed',
        session: 'maestro-test:test:suite:3:attempt-2',
        artifactsDir: '/tmp/replay-suite/payment',
      },
      expected:
        /^⨯ 03-payment\.ad \(9\.88s\)\n    failed at: assertVisible failed\n    session: maestro-test:test:suite:3:attempt-2\n    artifacts: \/tmp\/replay-suite\/payment$/,
    },
    {
      event: {
        type: 'replay-test',
        file: '/tmp/04-skip.ad',
        status: 'skip',
        index: 4,
        total: 5,
        message: 'missing platform metadata for --platform ios',
      },
      expected: /^- 04-skip\.ad\n    missing platform metadata for --platform ios$/,
    },
  ];

  for (const { event, expected } of cases) {
    assert.match(formatReplayTestProgressEvent(event) ?? '', expected);
  }
});

test('formatReplayTestProgressEvent colors stderr progress rows when stdout is piped', () => {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  try {
    const line = withStreamTty(process.stdout, false, () =>
      withStreamTty(process.stderr, true, () =>
        formatReplayTestProgressEvent({
          type: 'replay-test',
          file: '/tmp/01-pass.ad',
          status: 'pass',
          index: 1,
          total: 1,
          attempt: 1,
          durationMs: 10,
        }),
      ),
    );

    assert.equal(line, '\u001B[32m✓\u001B[39m 01-pass.ad (0.01s)');
  } finally {
    if (typeof originalForceColor === 'string') process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    if (typeof originalNoColor === 'string') process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  }
});

test('formatReplayTestProgressEvent colors completed result markers when color is enabled', () => {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
  try {
    formatReplayTestProgressEvent({
      type: 'replay-test-suite',
      status: 'start',
      total: 3,
      runnable: 3,
      skipped: 0,
      artifactsDir: '/tmp/replay-suite',
    });
    assert.equal(
      formatReplayTestProgressEvent({
        type: 'replay-test',
        file: '/tmp/01-pass.ad',
        status: 'pass',
        index: 1,
        total: 3,
        attempt: 1,
        durationMs: 10,
      }),
      '\u001B[32m✓\u001B[39m 01-pass.ad (0.01s)',
    );
    assert.equal(
      formatReplayTestProgressEvent({
        type: 'replay-test',
        file: '/tmp/02-flaky.yml',
        title: 'Retry flow',
        status: 'pass',
        index: 2,
        total: 3,
        attempt: 2,
        durationMs: 30,
      }),
      '\u001B[33m✓\u001B[39m "Retry flow" in 02-flaky.yml (0.03s)',
    );
    const failedLine = formatReplayTestProgressEvent({
      type: 'replay-test',
      file: '/tmp/03-fail.ad',
      title: 'Checkout failure',
      status: 'fail',
      index: 3,
      total: 3,
      attempt: 1,
      durationMs: 5,
      message: 'boom',
    });
    assert.ok(failedLine?.startsWith('\u001B[31m⨯\u001B[39m "Checkout failure" in 03-fail.ad'));
  } finally {
    if (typeof originalForceColor === 'string') process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    if (typeof originalNoColor === 'string') process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  }
});
