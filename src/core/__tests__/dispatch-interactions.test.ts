import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { mockRunIosRunnerCommand } = vi.hoisted(() => ({
  mockRunIosRunnerCommand: vi.fn(),
}));

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runIosRunnerCommand: mockRunIosRunnerCommand };
});

import {
  handlePanCommand,
  handlePressCommand,
  handleRotateGestureCommand,
  handleSwipeCommand,
  handleSwipePresetCommand,
  handleTransformGestureCommand,
} from '../dispatch-interactions.ts';
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
  mockRunIosRunnerCommand.mockReset();
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
    swipe: fail,
    pan: fail,
    fling: fail,
    longPress: fail,
    focus: fail,
    type: fail,
    fill: fail,
    scroll: fail,
    pinch: fail,
    screenshot: fail,
    snapshot: fail,
    back: fail,
    home: fail,
    rotate: fail,
    rotateGesture: fail,
    transformGesture: fail,
    appSwitcher: fail,
    readClipboard: fail,
    writeClipboard: fail,
    setSetting: fail,
  };
}

test('handleRotateGestureCommand defaults velocity sign to match degrees', async () => {
  const calls: unknown[][] = [];
  const interactor = {
    ...makeUnusedInteractor(),
    rotateGesture: async (...args: unknown[]) => {
      calls.push(args);
    },
  };

  const result = await handleRotateGestureCommand(IOS_SIMULATOR, interactor, [
    '-215',
    '200',
    '420',
  ]);

  assert.deepEqual(calls, [[-215, 200, 420, -1]]);
  assert.deepEqual(result, {
    degrees: -215,
    x: 200,
    y: 420,
    velocity: -1,
    message: 'Rotated gesture -215 degrees',
  });
});

test('handleSwipePresetCommand resolves Android in-page swipe to content lane', async () => {
  const calls: unknown[][] = [];
  const interactor = {
    ...makeUnusedInteractor(),
    snapshot: async () => ({
      backend: 'android' as const,
      nodes: [
        {
          index: 0,
          type: 'application',
          rect: { x: 0, y: 0, width: 400, height: 800 },
        },
      ],
    }),
    swipe: async (...args: unknown[]) => {
      calls.push(args);
    },
  };

  const result = await handleSwipePresetCommand(
    ANDROID_EMULATOR,
    interactor,
    ['left', '300'],
    undefined,
  );

  assert.deepEqual(calls, [[340, 400, 60, 400, 300]]);
  assert.deepEqual(result, {
    x1: 340,
    y1: 400,
    x2: 60,
    y2: 400,
    preset: 'left',
    durationMs: 300,
    effectiveDurationMs: 300,
    timingMode: 'direct',
    count: 1,
    pauseMs: 0,
    pattern: 'one-way',
    message: 'Swiped left',
  });
});

test('handleSwipeCommand preserves iOS swipe duration through dispatch', async () => {
  const calls: unknown[][] = [];
  const interactor = {
    ...makeUnusedInteractor(),
    swipe: async (...args: unknown[]) => {
      calls.push(args);
    },
  };

  const result = await handleSwipeCommand(
    IOS_SIMULATOR,
    interactor,
    ['100', '200', '180', '200', '300'],
    undefined,
  );

  assert.deepEqual(calls, [[100, 200, 180, 200, 300]]);
  assert.deepEqual(result, {
    x1: 100,
    y1: 200,
    x2: 180,
    y2: 200,
    durationMs: 300,
    effectiveDurationMs: 300,
    timingMode: 'direct',
    count: 1,
    pauseMs: 0,
    pattern: 'one-way',
    message: 'Swiped',
  });
});

test('handleSwipeCommand fuses repeated swipes into sequence drag steps with ping-pong unrolled', async () => {
  mockRunIosRunnerCommand.mockResolvedValueOnce({
    gestureStartUptimeMs: 100,
    gestureEndUptimeMs: 720,
    completedSteps: 2,
    sequenceResults: [
      { ok: true, kind: 'drag' },
      { ok: true, kind: 'drag' },
    ],
  });
  const interactor = makeUnusedInteractor();

  const result = await handleSwipeCommand(
    IOS_SIMULATOR,
    interactor,
    ['100', '650', '100', '450', '120'],
    {
      count: 2,
      pauseMs: 50,
      pattern: 'ping-pong',
      appBundleId: 'com.example.App',
    },
  );

  assert.deepEqual(mockRunIosRunnerCommand.mock.calls[0]?.[1], {
    command: 'sequence',
    steps: [
      // Ping-pong is unrolled daemon-side: odd indices swap endpoints, replacing the
      // runner-side pattern handling of the retired dragSeries command.
      {
        kind: 'drag',
        x: 100,
        y: 650,
        x2: 100,
        y2: 450,
        durationMs: 120,
        synthesized: true,
        pauseMs: 50,
      },
      {
        kind: 'drag',
        x: 100,
        y: 450,
        x2: 100,
        y2: 650,
        durationMs: 120,
        synthesized: true,
      },
    ],
    appBundleId: 'com.example.App',
  });
  assert.equal(result.timingMode, 'runner-sequence');
  assert.equal(result.completedSteps, 2);
  assert.equal(result.message, 'Swiped 2 times (ping-pong)');
});

test('handlePanCommand preserves interactor result metadata', async () => {
  const calls: unknown[][] = [];
  const interactor = {
    ...makeUnusedInteractor(),
    pan: async (...args: unknown[]) => {
      calls.push(args);
      return { backend: 'xctest' };
    },
  };

  const result = await handlePanCommand(interactor, ['196', '122', '80', '0', '500']);

  assert.deepEqual(calls, [[196, 122, 276, 122, 500]]);
  assert.deepEqual(result, {
    x: 196,
    y: 122,
    dx: 80,
    dy: 0,
    x2: 276,
    y2: 122,
    durationMs: 500,
    backend: 'xctest',
    message: 'Panned (196, 122) by (80, 0)',
  });
});

test('handleRotateGestureCommand routes Android through the interactor', async () => {
  const calls: unknown[][] = [];
  const interactor = {
    ...makeUnusedInteractor(),
    rotateGesture: async (...args: unknown[]) => {
      calls.push(args);
      return { backend: 'android-multitouch-helper' };
    },
  };

  const result = await handleRotateGestureCommand(ANDROID_EMULATOR, interactor, ['145']);

  assert.deepEqual(calls, [[145, undefined, undefined, 1]]);
  assert.deepEqual(result, {
    degrees: 145,
    velocity: 1,
    backend: 'android-multitouch-helper',
    message: 'Rotated gesture 145 degrees',
  });
});

test('handlePressCommand fuses an iOS jitter series into one sequence runner request', async () => {
  mockRunIosRunnerCommand.mockResolvedValueOnce({
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

  assert.equal(mockRunIosRunnerCommand.mock.calls.length, 1);
  const sent = mockRunIosRunnerCommand.mock.calls[0]?.[1] as RunnerCommand;
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
  mockRunIosRunnerCommand.mockResolvedValueOnce({
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

  assert.equal(mockRunIosRunnerCommand.mock.calls.length, 1);
  const sent = mockRunIosRunnerCommand.mock.calls[0]?.[1] as RunnerCommand;
  assert.equal(sent.command, 'sequence');
  assert.deepEqual(sent.steps, [
    { kind: 'longPress', x: 100, y: 200, durationMs: 300 },
    { kind: 'longPress', x: 100, y: 200, durationMs: 300 },
    { kind: 'longPress', x: 100, y: 200, durationMs: 300 },
  ]);
});

test('handlePressCommand fuses a plain iOS series into sequence tap steps (retired tapSeries route)', async () => {
  mockRunIosRunnerCommand.mockResolvedValueOnce({
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

  assert.equal(mockRunIosRunnerCommand.mock.calls.length, 1);
  const sent = mockRunIosRunnerCommand.mock.calls[0]?.[1] as RunnerCommand;
  assert.equal(sent.command, 'sequence');
  assert.deepEqual(sent.steps, [
    { kind: 'tap', x: 100, y: 200, synthesized: true, pauseMs: 80 },
    { kind: 'tap', x: 100, y: 200, synthesized: true },
  ]);
});

test('handlePressCommand fuses an iOS double-tap series into doubleTap sequence steps', async () => {
  mockRunIosRunnerCommand.mockResolvedValueOnce({
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

  assert.equal(mockRunIosRunnerCommand.mock.calls.length, 1);
  const sent = mockRunIosRunnerCommand.mock.calls[0]?.[1] as RunnerCommand;
  assert.equal(sent.command, 'sequence');
  // doubleTap steps never set synthesized — the runner's doubleTapAt path handles them.
  assert.deepEqual(sent.steps, [
    { kind: 'doubleTap', x: 100, y: 200, pauseMs: 50 },
    { kind: 'doubleTap', x: 100, y: 200 },
  ]);
});

test('handlePressCommand maps a failed sequence step to an AppError', async () => {
  mockRunIosRunnerCommand.mockResolvedValueOnce({
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
  mockRunIosRunnerCommand
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
  assert.equal(mockRunIosRunnerCommand.mock.calls.length, 2);
  const chunk1 = mockRunIosRunnerCommand.mock.calls[0]?.[1] as RunnerCommand;
  const chunk2 = mockRunIosRunnerCommand.mock.calls[1]?.[1] as RunnerCommand;
  assert.equal(chunk1.command, 'sequence');
  assert.equal(chunk1.steps?.length, 20);
  assert.equal(chunk2.command, 'sequence');
  assert.equal(chunk2.steps?.length, 5);
});

test('handlePressCommand aggregates completedSteps and gestureEnd across sequence chunks', async () => {
  // 45 jittered taps -> 3 chunks of 20/20/5. The aggregated result must report all 45 steps
  // and the LAST chunk's gestureEndUptimeMs, not just the first chunk's.
  mockRunIosRunnerCommand
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

  assert.equal(mockRunIosRunnerCommand.mock.calls.length, 3);
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
  mockRunIosRunnerCommand.mockResolvedValue({
    completedSteps: 0,
    sequenceResults: [],
  });

  await handlePressCommand(IOS_SIMULATOR, makeUnusedInteractor(), ['100', '200'], {
    count: 20,
    holdMs: 2000,
  });

  assert.ok(
    mockRunIosRunnerCommand.mock.calls.length > 1,
    `expected multiple chunks, got ${mockRunIosRunnerCommand.mock.calls.length}`,
  );
  // Every chunk's estimated holds + pauses + overhead must stay under the budget.
  for (const call of mockRunIosRunnerCommand.mock.calls) {
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

  assert.equal(mockRunIosRunnerCommand.mock.calls.length, 0);
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

  assert.equal(mockRunIosRunnerCommand.mock.calls.length, 0);
  assert.equal(longPresses.length, 3);
  assert.equal(result.pressed, true);
});

test('handleTransformGestureCommand routes iOS simulator through the interactor', async () => {
  const calls: unknown[][] = [];
  const interactor = {
    ...makeUnusedInteractor(),
    transformGesture: async (...args: unknown[]) => {
      calls.push(args);
      return { backend: 'xctest' };
    },
  };

  const result = await handleTransformGestureCommand(IOS_SIMULATOR, interactor, [
    '200',
    '420',
    '80',
    '-40',
    '2',
    '35',
  ]);

  assert.deepEqual(calls, [
    [{ x: 200, y: 420, dx: 80, dy: -40, scale: 2, degrees: 35, durationMs: undefined }],
  ]);
  assert.deepEqual(result, {
    x: 200,
    y: 420,
    dx: 80,
    dy: -40,
    scale: 2,
    degrees: 35,
    durationMs: undefined,
    backend: 'xctest',
    message: 'Requested transform gesture by (80, -40), scale 2, rotate 35 degrees',
  });
});
