import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

import { handlePressCommand } from '../dispatch-interactions.ts';
import type { Interactor } from '../interactor-types.ts';
import type { RunnerCommand } from '../../platforms/apple/core/runner/runner-contract.ts';
import { AppError } from '../../kernel/errors.ts';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';

vi.mock('../../platforms/apple/os/macos/helper.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/apple/os/macos/helper.ts')>();
  return {
    ...actual,
    runMacOsPressAction: vi.fn(async () => ({})),
  };
});

beforeEach(() => {
  mockRunAppleRunnerCommand.mockReset();
});

function makeUnusedInteractor(): Interactor {
  const fail = async () => {
    throw new Error('interactor should not be used for macOS menubar press');
  };
  return {
    open: fail,
    openDevice: fail,
    close: fail,
    tap: fail,
    doubleTap: fail,
    longPress: fail,
    focus: fail,
    type: fail,
    fill: fail,
    scroll: fail,
    screenshot: fail,
    snapshot: fail,
    back: fail,
    home: fail,
    rotate: fail,
    appSwitcher: fail,
    tvRemote: fail,
    readClipboard: fail,
    writeClipboard: fail,
    setSetting: fail,
  };
}

test('handlePressCommand fuses an iOS jitter series into one sequence runner request', async () => {
  mockRunAppleRunnerCommand.mockResolvedValueOnce({
    completedSteps: 3,
    sequenceResults: [
      { ok: true, kind: 'tap' },
      { ok: true, kind: 'tap' },
      { ok: true, kind: 'tap' },
    ],
    gestureStartUptimeMs: 100,
    gestureEndUptimeMs: 260,
  });
  const interactor = makeUnusedInteractor();

  const result = await handlePressCommand(IOS_SIMULATOR, interactor, ['100', '200'], {
    count: 3,
    jitterPx: 2,
    intervalMs: 40,
    appBundleId: 'com.example.App',
  });

  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
  const sent = mockRunAppleRunnerCommand.mock.calls[0]?.[1] as RunnerCommand;
  assert.equal(sent.command, 'sequence');
  assert.equal(sent.appBundleId, 'com.example.App');
  assert.deepEqual(sent.steps, [
    { kind: 'tap', x: 100, y: 200, synthesized: true, pauseMs: 40 },
    { kind: 'tap', x: 102, y: 200, synthesized: true, pauseMs: 40 },
    { kind: 'tap', x: 100, y: 202, synthesized: true },
  ]);
  assert.equal(result.timingMode, 'runner-sequence');
  assert.equal(result.message, 'Tapped (100, 200)');
});

test('handlePressCommand fuses an iOS hold series into longPress sequence steps', async () => {
  mockRunAppleRunnerCommand.mockResolvedValueOnce({
    completedSteps: 3,
    sequenceResults: [
      { ok: true, kind: 'longPress' },
      { ok: true, kind: 'longPress' },
      { ok: true, kind: 'longPress' },
    ],
  });
  const interactor = makeUnusedInteractor();

  await handlePressCommand(IOS_SIMULATOR, interactor, ['100', '200'], {
    count: 3,
    holdMs: 300,
  });

  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
  const sent = mockRunAppleRunnerCommand.mock.calls[0]?.[1] as RunnerCommand;
  assert.equal(sent.command, 'sequence');
  assert.deepEqual(sent.steps, [
    { kind: 'longPress', x: 100, y: 200, durationMs: 300 },
    { kind: 'longPress', x: 100, y: 200, durationMs: 300 },
    { kind: 'longPress', x: 100, y: 200, durationMs: 300 },
  ]);
});

test('handlePressCommand fuses a plain iOS series into sequence tap steps (retired tapSeries route)', async () => {
  mockRunAppleRunnerCommand.mockResolvedValueOnce({
    completedSteps: 2,
    sequenceResults: [
      { ok: true, kind: 'tap' },
      { ok: true, kind: 'tap' },
    ],
  });

  await handlePressCommand(IOS_SIMULATOR, makeUnusedInteractor(), ['100', '200'], {
    count: 2,
    intervalMs: 80,
  });

  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
  const sent = mockRunAppleRunnerCommand.mock.calls[0]?.[1] as RunnerCommand;
  assert.equal(sent.command, 'sequence');
  assert.deepEqual(sent.steps, [
    { kind: 'tap', x: 100, y: 200, synthesized: true, pauseMs: 80 },
    { kind: 'tap', x: 100, y: 200, synthesized: true },
  ]);
});

test('handlePressCommand fuses an iOS double-tap series into doubleTap sequence steps', async () => {
  mockRunAppleRunnerCommand.mockResolvedValueOnce({
    completedSteps: 2,
    sequenceResults: [
      { ok: true, kind: 'doubleTap' },
      { ok: true, kind: 'doubleTap' },
    ],
  });

  await handlePressCommand(IOS_SIMULATOR, makeUnusedInteractor(), ['100', '200'], {
    count: 2,
    doubleTap: true,
    intervalMs: 50,
  });

  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
  const sent = mockRunAppleRunnerCommand.mock.calls[0]?.[1] as RunnerCommand;
  assert.equal(sent.command, 'sequence');
  // doubleTap steps never set synthesized — the runner's doubleTapAt path handles them.
  assert.deepEqual(sent.steps, [
    { kind: 'doubleTap', x: 100, y: 200, pauseMs: 50 },
    { kind: 'doubleTap', x: 100, y: 200 },
  ]);
});

test('handlePressCommand maps a failed sequence step to an AppError', async () => {
  mockRunAppleRunnerCommand.mockResolvedValueOnce({
    completedSteps: 1,
    failedStepIndex: 1,
    sequenceResults: [
      { ok: true, kind: 'tap' },
      { ok: false, kind: 'tap', errorCode: 'UNSUPPORTED_OPERATION', errorMessage: 'tap blocked' },
    ],
  });

  await assert.rejects(
    () =>
      handlePressCommand(IOS_SIMULATOR, makeUnusedInteractor(), ['100', '200'], {
        count: 2,
        jitterPx: 2,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details?.failedStepIndex, 1);
      return true;
    },
  );
});

test('handlePressCommand rebases a chunk-2 failure to global step/completed indices', async () => {
  // 25 jittered taps -> 2 chunks of 20/5. Chunk 2 fails at its LOCAL step index 2 (global 22),
  // having completed 2 of its steps locally (global 22). No chunk 3 must be sent.
  mockRunAppleRunnerCommand
    .mockResolvedValueOnce({
      completedSteps: 20,
      sequenceResults: Array.from({ length: 20 }, () => ({ ok: true, kind: 'tap' })),
    })
    .mockResolvedValueOnce({
      completedSteps: 2,
      failedStepIndex: 2,
      sequenceResults: [
        { ok: true, kind: 'tap' },
        { ok: true, kind: 'tap' },
        {
          ok: false,
          kind: 'tap',
          errorCode: 'UNSUPPORTED_OPERATION',
          errorMessage: 'tap blocked',
        },
      ],
    });

  await assert.rejects(
    () =>
      handlePressCommand(IOS_SIMULATOR, makeUnusedInteractor(), ['100', '200'], {
        count: 25,
        jitterPx: 2,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details?.failedStepIndex, 22);
      assert.equal(error.details?.completedSteps, 22);
      assert.equal(error.details?.chunkStepIndex, 2);
      return true;
    },
  );

  // Both chunk requests were sent; the failure stopped chunk 3 from ever being issued.
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 2);
  const chunk1 = mockRunAppleRunnerCommand.mock.calls[0]?.[1] as RunnerCommand;
  const chunk2 = mockRunAppleRunnerCommand.mock.calls[1]?.[1] as RunnerCommand;
  assert.equal(chunk1.command, 'sequence');
  assert.equal(chunk1.steps?.length, 20);
  assert.equal(chunk2.command, 'sequence');
  assert.equal(chunk2.steps?.length, 5);
});

test('handlePressCommand aggregates completedSteps and gestureEnd across sequence chunks', async () => {
  // 45 jittered taps -> 3 chunks of 20/20/5. The aggregated result must report all 45 steps
  // and the LAST chunk's gestureEndUptimeMs, not just the first chunk's.
  mockRunAppleRunnerCommand
    .mockResolvedValueOnce({
      completedSteps: 20,
      sequenceResults: Array.from({ length: 20 }, () => ({ ok: true, kind: 'tap' })),
      gestureStartUptimeMs: 100,
      gestureEndUptimeMs: 300,
      x: 0.5,
      y: 0.5,
    })
    .mockResolvedValueOnce({
      completedSteps: 20,
      sequenceResults: Array.from({ length: 20 }, () => ({ ok: true, kind: 'tap' })),
      gestureStartUptimeMs: 400,
      gestureEndUptimeMs: 600,
    })
    .mockResolvedValueOnce({
      completedSteps: 5,
      sequenceResults: Array.from({ length: 5 }, () => ({ ok: true, kind: 'tap' })),
      gestureStartUptimeMs: 700,
      gestureEndUptimeMs: 900,
    });

  const result = await handlePressCommand(IOS_SIMULATOR, makeUnusedInteractor(), ['100', '200'], {
    count: 45,
    jitterPx: 2,
  });

  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 3);
  assert.equal(result.completedSteps, 45);
  assert.equal((result.sequenceResults as unknown[]).length, 45);
  // First chunk frame/start preserved, last chunk end.
  assert.equal(result.gestureStartUptimeMs, 100);
  assert.equal(result.gestureEndUptimeMs, 900);
  assert.equal(result.x, 0.5);
});

test('handlePressCommand sub-chunks a hold series by estimated duration under the runner watchdog', async () => {
  // count=20 hold-ms=2000 is ~40s of holds in one chunk -> over the 30s main-thread watchdog.
  // The duration budget must split it into multiple sub-chunks even though step count <= 20.
  mockRunAppleRunnerCommand.mockResolvedValue({
    completedSteps: 0,
    sequenceResults: [],
  });

  await handlePressCommand(IOS_SIMULATOR, makeUnusedInteractor(), ['100', '200'], {
    count: 20,
    holdMs: 2000,
  });

  assert.ok(
    mockRunAppleRunnerCommand.mock.calls.length > 1,
    `expected multiple chunks, got ${mockRunAppleRunnerCommand.mock.calls.length}`,
  );
  // Every chunk's estimated holds + pauses + overhead must stay under the budget.
  for (const call of mockRunAppleRunnerCommand.mock.calls) {
    const sent = call[1] as RunnerCommand;
    const steps = sent.steps ?? [];
    const estimatedMs = steps.reduce(
      (sum, step) => sum + (step.durationMs ?? 0) + (step.pauseMs ?? 0) + 250,
      0,
    );
    assert.ok(estimatedMs <= 20_000, `chunk estimated ${estimatedMs}ms exceeds budget`);
  }
});

test('handlePressCommand count=1 keeps the direct (non-sequence) path on iOS', async () => {
  const taps: unknown[][] = [];
  const interactor = {
    ...makeUnusedInteractor(),
    tap: async (...args: unknown[]) => {
      taps.push(args);
      return undefined;
    },
  };

  await handlePressCommand(IOS_SIMULATOR, interactor, ['100', '200'], { count: 1, jitterPx: 2 });

  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
  assert.deepEqual(taps, [[100, 200]]);
});

test('handlePressCommand on Android keeps the direct path even with hold', async () => {
  const longPresses: unknown[][] = [];
  const interactor = {
    ...makeUnusedInteractor(),
    // Returns a non-nullish result: every iteration must still perform its
    // press even once the kept-first result is set (regression for a `??=`
    // short-circuit that skipped presses 2..N).
    longPress: async (...args: unknown[]) => {
      longPresses.push(args);
      return { pressed: true };
    },
  };

  const result = await handlePressCommand(ANDROID_EMULATOR, interactor, ['100', '200'], {
    count: 3,
    holdMs: 200,
  });

  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
  assert.equal(longPresses.length, 3);
  assert.equal(result.pressed, true);
});
