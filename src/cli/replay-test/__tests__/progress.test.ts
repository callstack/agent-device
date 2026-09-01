import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createReplayTestProgressRenderer } from '../progress.ts';
import type { ReplayTestResult } from '../reporters/types.ts';

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

function renderTestResult(
  event: ReplayTestResult,
  options?: Parameters<typeof createReplayTestProgressRenderer>[0],
): string | undefined {
  return createReplayTestProgressRenderer(options).render({ type: 'test-result', test: event })
    ?.text;
}

function withForcedColor<T>(run: () => T): T {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
  try {
    return run();
  } finally {
    restoreEnvValue('FORCE_COLOR', originalForceColor);
    restoreEnvValue('NO_COLOR', originalNoColor);
  }
}

function restoreEnvValue(name: 'FORCE_COLOR' | 'NO_COLOR', value: string | undefined): void {
  if (typeof value === 'string') process.env[name] = value;
  else delete process.env[name];
}

test('createReplayTestProgressRenderer renders pass, retry, fail, and skip cases', () => {
  const cases: Array<{ event: ReplayTestResult; expected: RegExp }> = [
    {
      event: {
        file: '/tmp/01-login.ad',
        status: 'pass',
        index: 1,
        total: 3,
        attempt: 2,
        maxAttempts: 2,
        durationMs: 12_345,
      },
      expected: /^✓ 01-login\.ad 12\.3s$/,
    },
    {
      event: {
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
        file: '/tmp/03-payment.ad',
        title: 'Payment flow',
        status: 'fail',
        index: 3,
        total: 3,
        attempt: 2,
        maxAttempts: 2,
        durationMs: 9_876,
        message: 'assertVisible failed',
        hint: 'Stop the owning daemon and retry',
        session: 'maestro-test:test:suite:3:attempt-2',
        artifactsDir: '/tmp/replay-suite/payment',
      },
      expected:
        /^⨯ Payment flow 9\.88s\n {4}file: 03-payment\.ad\n {4}failed at: assertVisible failed\n {4}hint: Stop the owning daemon and retry\n {4}session: maestro-test:test:suite:3:attempt-2\n {4}artifacts: \/tmp\/replay-suite\/payment$/,
    },
    {
      event: {
        file: '/tmp/05-sharded.ad',
        title: 'Sharded flow',
        status: 'pass',
        index: 5,
        total: 6,
        attempt: 1,
        durationMs: 100,
        shardIndex: 0,
        shardCount: 2,
        deviceId: 'emulator-5554',
        deviceName: 'Pixel 8',
      },
      expected: /^✓ Sharded flow \[1\/2 Pixel 8\] 0\.1s$/,
    },
    {
      event: {
        file: '/tmp/04-skip.ad',
        status: 'skip',
        index: 4,
        total: 5,
        message: 'missing platform metadata for --platform ios',
      },
      expected: /^- 04-skip\.ad\n {4}missing platform metadata for --platform ios$/,
    },
  ];

  for (const { event, expected } of cases) {
    assert.match(renderTestResult(event) ?? '', expected);
  }
});

test('createReplayTestProgressRenderer colors stderr progress rows when stdout is piped', () => {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  try {
    const line = withStreamTty(process.stdout, false, () =>
      withStreamTty(process.stderr, true, () =>
        renderTestResult({
          file: '/tmp/01-pass.ad',
          status: 'pass',
          index: 1,
          total: 1,
          attempt: 1,
          durationMs: 10,
        }),
      ),
    );

    assert.equal(line, '\u001B[32m✓\u001B[39m 01-pass.ad \u001B[33m0.01s\u001B[39m');
  } finally {
    if (typeof originalForceColor === 'string') process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    if (typeof originalNoColor === 'string') process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  }
});

test('createReplayTestProgressRenderer renders live step progress with spinner and action detail', () => {
  withForcedColor(() => {
    const renderer = createReplayTestProgressRenderer({ liveProgress: true });
    const rendered = renderer.render({
      type: 'test-step',
      test: {
        file: '/tmp/checkout.yaml',
        title: 'Checkout flow',
        index: 1,
        total: 1,
        stepIndex: 3,
        stepTotal: 20,
        stepCommand: 'tapOn',
        stepValue: 'Sign in',
      },
    });

    assert.deepEqual(rendered, {
      text: '\r\u001B[2K\u001B[34m⠋\u001B[39m Checkout flow \u001B[2m[\u001B[22m\u001B[2m3/20\u001B[22m \u001B[35mtapOn\u001B[39m \u001B[32mSign in\u001B[39m\u001B[2m]\u001B[22m',
      newline: false,
    });
  });
});

test('createReplayTestProgressRenderer trims live step progress by visible columns', () => {
  withForcedColor(() => {
    const renderer = createReplayTestProgressRenderer({ liveProgress: true, columns: 56 });
    const rendered = renderer.render({
      type: 'test-step',
      test: {
        file: '/tmp/checkout-form.yaml',
        index: 1,
        total: 1,
        stepIndex: 2,
        stepTotal: 20,
        stepCommand: 'assertVisible',
        stepValue: 'Agent',
      },
    });

    assert.deepEqual(rendered, {
      text: '\r\u001B[2K\u001B[34m⠋\u001B[39m checkout-form.yaml \u001B[2m[\u001B[22m\u001B[2m2/20\u001B[22m \u001B[35massertVisible\u001B[39m \u001B[32mAgent\u001B[39m\u001B[2m]\u001B[22m',
      newline: false,
    });

    const truncatingRenderer = createReplayTestProgressRenderer({
      liveProgress: true,
      columns: 36,
    });
    const truncated = truncatingRenderer.render({
      type: 'test-step',
      test: {
        file: '/tmp/checkout-form.yaml',
        index: 1,
        total: 1,
        stepIndex: 2,
        stepTotal: 20,
        stepCommand: 'assertVisible',
        stepValue: 'Agent Login',
      },
    });
    assert.ok(truncated?.text.endsWith('...\u001B[0m'));
  });
});

test('createReplayTestProgressRenderer clears every reflowed row after a terminal resize', () => {
  const initialColumns = 80;
  const resizedColumns = 20;
  const clearRow = '\r\u001B[2K';
  const moveUpAndClearRow = '\u001B[1A\r\u001B[2K';
  let columns = initialColumns;
  const renderer = createReplayTestProgressRenderer({
    liveProgress: true,
    columns: () => columns,
  });
  const initial = renderer.render({
    type: 'test-step',
    test: {
      file: '/tmp/checkout.yaml',
      title: 'A long Maestro test title that is one row before terminal reflow',
      index: 1,
      total: 1,
      stepIndex: 8,
      stepTotal: 12,
      stepCommand: 'assertVisible',
      stepValue: 'Confirmation',
    },
  });
  assert.ok(initial?.text.startsWith(clearRow));
  const initialVisibleWidth = (initial?.text.length ?? clearRow.length) - clearRow.length;
  assert.equal(initialVisibleWidth, initialColumns);

  columns = resizedColumns;
  const rendered = renderer.render({
    type: 'test-step',
    test: {
      file: '/tmp/checkout.yaml',
      title: 'A long Maestro test title that is one row before terminal reflow',
      index: 1,
      total: 1,
      stepIndex: 9,
      stepTotal: 12,
      stepCommand: 'tapOn',
      stepValue: 'Continue',
    },
  });

  const reflowedRows = Math.ceil(initialVisibleWidth / resizedColumns);
  const expectedClearPrefix = clearRow + moveUpAndClearRow.repeat(Math.max(0, reflowedRows - 1));
  assert.equal(reflowedRows, 4);
  assert.equal(rendered?.text.slice(0, expectedClearPrefix.length), expectedClearPrefix);
  assert.equal((rendered?.text.split('\u001B[2K').length ?? 1) - 1, reflowedRows);
  assert.ok(rendered?.text.endsWith('...'));
});

test('createReplayTestProgressRenderer clears every row after a large terminal reflow', () => {
  const initialColumns = 200;
  const resizedColumns = 20;
  const clearRow = '\r\u001B[2K';
  const moveUpAndClearRow = '\u001B[1A\r\u001B[2K';
  let columns = initialColumns;
  const renderer = createReplayTestProgressRenderer({
    liveProgress: true,
    columns: () => columns,
    terminalReflowsOnResize: true,
  });
  const initial = renderer.render({
    type: 'test-step',
    test: {
      file: '/tmp/checkout.yaml',
      title: 'x'.repeat(180),
      index: 1,
      total: 1,
      stepIndex: 8,
      stepTotal: 12,
      stepCommand: 'assertVisible',
      stepValue: 'Confirmation',
    },
  });
  assert.ok(initial?.text.startsWith(clearRow));
  const initialVisibleWidth = (initial?.text.length ?? clearRow.length) - clearRow.length;
  assert.equal(initialVisibleWidth, initialColumns);

  columns = resizedColumns;
  const rendered = renderer.render({
    type: 'test-step',
    test: {
      file: '/tmp/checkout.yaml',
      title: 'Checkout',
      index: 1,
      total: 1,
      stepIndex: 9,
      stepTotal: 12,
      stepCommand: 'tapOn',
      stepValue: 'Continue',
    },
  });

  const reflowedRows = Math.ceil(initialVisibleWidth / resizedColumns);
  const expectedClearPrefix = clearRow + moveUpAndClearRow.repeat(reflowedRows - 1);
  assert.equal(reflowedRows, 10);
  assert.equal(rendered?.text.slice(0, expectedClearPrefix.length), expectedClearPrefix);
  assert.equal((rendered?.text.split('\u001B[1A').length ?? 1) - 1, 9);
  assert.equal((rendered?.text.split('\u001B[2K').length ?? 1) - 1, 10);
});

test('createReplayTestProgressRenderer stays on one row in non-reflowing terminals', () => {
  let columns = 200;
  const renderer = createReplayTestProgressRenderer({
    liveProgress: true,
    columns: () => columns,
    terminalReflowsOnResize: false,
  });
  renderer.render({
    type: 'test-step',
    test: {
      file: '/tmp/checkout.yaml',
      title: 'x'.repeat(180),
      index: 1,
      total: 1,
      stepIndex: 8,
      stepTotal: 12,
      stepCommand: 'assertVisible',
      stepValue: 'Confirmation',
    },
  });

  columns = 20;
  const rendered = renderer.render({
    type: 'test-step',
    test: {
      file: '/tmp/checkout.yaml',
      title: 'Checkout',
      index: 1,
      total: 1,
      stepIndex: 9,
      stepTotal: 12,
      stepCommand: 'tapOn',
      stepValue: 'Continue',
    },
  });

  assert.equal((rendered?.text.split('\u001B[1A').length ?? 1) - 1, 0);
  assert.equal((rendered?.text.split('\u001B[2K').length ?? 1) - 1, 1);
});

test('createReplayTestProgressRenderer colors completed result markers when color is enabled', () => {
  withForcedColor(() => {
    assert.equal(
      renderTestResult({
        file: '/tmp/01-pass.ad',
        status: 'pass',
        index: 1,
        total: 3,
        attempt: 1,
        durationMs: 10,
      }),
      '\u001B[32m✓\u001B[39m 01-pass.ad \u001B[33m0.01s\u001B[39m',
    );
    assert.equal(
      renderTestResult({
        file: '/tmp/02-flaky.yml',
        title: 'Retry flow',
        status: 'pass',
        index: 2,
        total: 3,
        attempt: 2,
        durationMs: 30,
      }),
      '\u001B[33m✓\u001B[39m Retry flow \u001B[33m0.03s\u001B[39m',
    );
    const failedLine = renderTestResult({
      file: '/tmp/03-fail.ad',
      title: 'Checkout failure',
      status: 'fail',
      index: 3,
      total: 3,
      attempt: 1,
      durationMs: 5,
      message: 'boom',
    });
    assert.ok(failedLine?.startsWith('\u001B[31m⨯\u001B[39m Checkout failure'));
  });
});
