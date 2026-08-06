import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { iosRunnerOverrides, performGestureApple } from '../../interactions.ts';
import { runAppleRunnerCommand } from '../runner/runner-client.ts';
import { AppError } from '@agent-device/kernel/errors';
import { TEXT_ENTRY_ROUTES, type GesturePlan } from '@agent-device/contracts/interaction';
import { requireGestureSupported } from '../../../../core/capabilities.ts';
import {
  IOS_TEST_DEVICE,
  IOS_TEST_SIMULATOR,
  MACOS_TEST_DEVICE,
  TVOS_TEST_SIMULATOR,
} from './apple-core-stub-helpers.ts';

vi.mock('../runner/runner-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: vi.fn(actual.runAppleRunnerCommand) };
});

const runnerActual = await vi.importActual<typeof import('../runner/runner-client.ts')>(
  '../runner/runner-client.ts',
);

const mockRunAppleRunnerCommand = vi.mocked(runAppleRunnerCommand);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunAppleRunnerCommand.mockImplementation(runnerActual.runAppleRunnerCommand);
});

function twoFingerPanPlan(): Extract<GesturePlan, { topology: 'two' }> {
  return {
    topology: 'two',
    intent: 'pan',
    durationMs: 32,
    viewport: { x: 0, y: 0, width: 400, height: 800 },
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point: { x: 100, y: 80 } },
          { offsetMs: 16, point: { x: 110, y: 85 } },
          { offsetMs: 32, point: { x: 120, y: 90 } },
        ],
      },
      {
        pointerId: 1,
        samples: [
          { offsetMs: 0, point: { x: 100, y: 120 } },
          { offsetMs: 16, point: { x: 110, y: 125 } },
          { offsetMs: 32, point: { x: 120, y: 130 } },
        ],
      },
    ],
  };
}

function singlePanPlan(): Extract<GesturePlan, { topology: 'single' }> {
  return {
    topology: 'single',
    intent: 'pan',
    executionProfile: 'timed-pan',
    durationMs: 500,
    viewport: { x: 0, y: 0, width: 400, height: 800 },
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point: { x: 100, y: 200 } },
          { offsetMs: 500, point: { x: 180, y: 160 } },
        ],
      },
    ],
  };
}

test('iosRunnerOverrides uses synthesized iOS coordinate taps', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({});

  const { overrides } = iosRunnerOverrides(IOS_TEST_SIMULATOR, {
    appBundleId: 'com.example.App',
  });

  await overrides.tap(100, 200);
  await overrides.focus(110, 210);

  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'tap',
    x: 100,
    y: 200,
    synthesized: true,
    appBundleId: 'com.example.App',
  });
  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[1]?.[1], {
    command: 'tap',
    x: 110,
    y: 210,
    synthesized: true,
    appBundleId: 'com.example.App',
  });
});

test('iosRunnerOverrides uses synthesized iOS coordinate taps for selectors', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({});

  const { overrides } = iosRunnerOverrides(IOS_TEST_DEVICE, {
    appBundleId: 'com.example.App',
  });

  await overrides.tapElementSelector!({
    key: 'label',
    value: 'General',
    expectedPoint: { x: 200, y: 300 },
  });

  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'tap',
    selectorKey: 'label',
    selectorValue: 'General',
    allowNonHittableCoordinateFallback: undefined,
    x: 200,
    y: 300,
    synthesized: true,
    appBundleId: 'com.example.App',
  });
});

test('iosRunnerOverrides reads and validates the fresh gesture viewport', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({ x: 10, y: 20, x2: 300, y2: 500 });
  const { overrides } = iosRunnerOverrides(IOS_TEST_SIMULATOR, {
    appBundleId: 'com.example.App',
  });
  assert.ok(overrides.gestureViewport);
  assert.deepEqual(await overrides.gestureViewport(), { x: 10, y: 20, width: 300, height: 500 });
  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'gestureViewport',
    appBundleId: 'com.example.App',
  });
  mockRunAppleRunnerCommand.mockResolvedValue({ x: 0, y: 0, x2: 0, y2: 500 });
  await assert.rejects(() => overrides.gestureViewport!(), { code: 'COMMAND_FAILED' });
});

for (const [name, device] of [
  ['macOS', MACOS_TEST_DEVICE],
  ['tvOS', TVOS_TEST_SIMULATOR],
] as const) {
  test(`iosRunnerOverrides keeps ${name} coordinate taps on the standard path`, async () => {
    mockRunAppleRunnerCommand.mockResolvedValue({});

    const { overrides } = iosRunnerOverrides(device, {
      appBundleId: 'com.example.App',
    });

    await overrides.tap(100, 200);

    assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
      command: 'tap',
      x: 100,
      y: 200,
      appBundleId: 'com.example.App',
    });
  });
}

test('performGestureApple sends exact two-pointer pan samples through gesture', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({ transformed: true });
  const plan = twoFingerPanPlan();

  const result = await performGestureApple(
    IOS_TEST_SIMULATOR,
    { appBundleId: 'com.example.App' },
    {},
    plan,
  );

  assert.deepEqual(result, { transformed: true });
  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'gesture',
    gesturePlan: plan,
    appBundleId: 'com.example.App',
  });
});

test('Apple admission and execution share the same multi-touch refusal', async () => {
  let admissionError: AppError | undefined;
  try {
    requireGestureSupported(
      {
        intent: 'pan',
        origin: { x: 100, y: 200 },
        delta: { x: 80, y: -40 },
        pointerCount: 2,
      },
      IOS_TEST_DEVICE,
    );
  } catch (error) {
    if (error instanceof AppError) admissionError = error;
  }
  assert.ok(admissionError);

  await assert.rejects(
    () => performGestureApple(IOS_TEST_DEVICE, {}, {}, twoFingerPanPlan()),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.message === admissionError.message &&
      error.details?.hint === admissionError.details?.hint,
  );
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});

test('performGestureApple composes macOS one-contact plans with the drag executor', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({ dragged: true });
  const plan = singlePanPlan();

  await performGestureApple(MACOS_TEST_DEVICE, { appBundleId: 'com.example.App' }, {}, plan);

  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'drag',
    x: 100,
    y: 200,
    x2: 180,
    y2: 160,
    durationMs: 500,
    appBundleId: 'com.example.App',
  });
});

test('performGestureApple composes tvOS one-contact plans with remote direction', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({ swiped: true });

  await performGestureApple(TVOS_TEST_SIMULATOR, {}, {}, singlePanPlan());

  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'swipe',
    direction: 'right',
    appBundleId: undefined,
  });
});

test('iosRunnerOverrides maps iOS scroll to a single fused scroll command', async () => {
  // The fused scroll resolves the frame and performs the duration-aware drag in one runner
  // lifecycle command; no separate interactionFrame request is needed.
  mockRunAppleRunnerCommand.mockResolvedValueOnce({
    x: 200,
    y: 640,
    x2: 200,
    y2: 160,
    referenceWidth: 400,
    referenceHeight: 800,
  });

  const { overrides } = iosRunnerOverrides(IOS_TEST_SIMULATOR, {
    appBundleId: 'com.example.App',
  });

  const result = await overrides.scroll('down', { durationMs: 50 });

  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'scroll',
    direction: 'down',
    durationMs: 50,
    appBundleId: 'com.example.App',
  });
  assert.deepEqual(result, {
    x1: 200,
    y1: 640,
    x2: 200,
    y2: 160,
    referenceWidth: 400,
    referenceHeight: 800,
    pixels: 480,
    durationMs: 50,
  });
});

test('iosRunnerOverrides maps iOS scroll without duration to a fused runner scroll', async () => {
  mockRunAppleRunnerCommand.mockResolvedValueOnce({
    x: 200,
    y: 640,
    x2: 200,
    y2: 240,
    referenceWidth: 400,
    referenceHeight: 800,
  });

  const { overrides } = iosRunnerOverrides(IOS_TEST_SIMULATOR, {
    appBundleId: 'com.example.App',
  });

  await overrides.scroll('down', { pixels: 400 });

  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'scroll',
    direction: 'down',
    pixels: 400,
    appBundleId: 'com.example.App',
  });
});

test('iosRunnerOverrides maps tvOS scroll duration to remote press hold duration', async () => {
  mockRunAppleRunnerCommand.mockResolvedValueOnce({
    ok: true,
  });

  const { overrides } = iosRunnerOverrides(TVOS_TEST_SIMULATOR, {
    appBundleId: 'com.example.App',
  });

  const result = await overrides.scroll('down', { durationMs: 50 });

  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'remotePress',
    remoteButton: 'down',
    durationMs: 50,
    appBundleId: 'com.example.App',
  });
  assert.deepEqual(result, { durationMs: 50 });
});

test('iosRunnerOverrides maps macOS desktop scroll to a desktop wheel command', async () => {
  mockRunAppleRunnerCommand.mockResolvedValueOnce({
    x: 737.5,
    y: 476.5,
    referenceWidth: 400,
    referenceHeight: 800,
  });

  const { overrides } = iosRunnerOverrides(MACOS_TEST_DEVICE, {
    appBundleId: 'com.example.App',
  });

  const result = await overrides.scroll('down', { pixels: 200, durationMs: 50 });

  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'desktopScroll',
    direction: 'down',
    pixels: 200,
    durationMs: 50,
    appBundleId: 'com.example.App',
  });
  assert.deepEqual(result, {
    x1: 737.5,
    y1: 476.5,
    referenceWidth: 400,
    referenceHeight: 800,
    pixels: 200,
    durationMs: 50,
  });
});

test('iosRunnerOverrides rejects macOS desktop scroll duration above the shared cap', async () => {
  const { overrides } = iosRunnerOverrides(MACOS_TEST_DEVICE, {
    appBundleId: 'com.example.App',
  });

  await assert.rejects(() => overrides.scroll('down', { pixels: 200, durationMs: 10_001 }), {
    code: 'INVALID_ARGS',
  });
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});

// #1588 widened `Interactor.type` to a bag purely so a `textEntryRoute` string
// could escape the runner. This narrowing replaced it: the runner wire payload
// is untrusted JSON, and exactly one typed field crosses into
// TypeTextBackendResult.
test('iosRunnerOverrides narrows the runner type payload to the text-entry route', async () => {
  mockRunAppleRunnerCommand.mockResolvedValueOnce({
    textEntryRoute: 'synthesized-first-responder',
    verified: true,
    referenceWidth: 400,
    referenceHeight: 800,
  });

  const { overrides } = iosRunnerOverrides(IOS_TEST_SIMULATOR, {
    appBundleId: 'com.example.App',
  });

  assert.deepEqual(await overrides.type('hello', 25), {
    textEntryRoute: 'synthesized-first-responder',
  });
});

test('iosRunnerOverrides reports no route when the runner names one it does not model', async () => {
  mockRunAppleRunnerCommand.mockResolvedValueOnce({ textEntryRoute: 'unmodelled-route' });

  const { overrides } = iosRunnerOverrides(IOS_TEST_SIMULATOR, {
    appBundleId: 'com.example.App',
  });

  assert.deepEqual(await overrides.type('hello'), {});
});

// Route parity: dropping an unmodelled route (above) is only safe while the TS
// union names every route the Swift runner can assign. Read the producers
// rather than trusting the union — a fifth route added on the Swift side would
// otherwise disappear from the `type` response with nothing turning red.
test('TEXT_ENTRY_ROUTES names every route the Swift runner assigns', () => {
  const runnerTestsDir = path.resolve(
    import.meta.dirname,
    '../../../../../apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests',
  );
  const swiftRoutes = new Set<string>();
  for (const entry of fs.readdirSync(runnerTestsDir)) {
    if (!entry.endsWith('.swift')) continue;
    const source = fs.readFileSync(path.join(runnerTestsDir, entry), 'utf8');
    for (const match of source.matchAll(/textEntryRoute[^"\n]*"([^"\n]+)"/g)) {
      swiftRoutes.add(match[1]!);
    }
  }

  assert.ok(swiftRoutes.size > 0, 'expected to find textEntryRoute literals in the runner sources');
  assert.deepEqual([...swiftRoutes].sort(), [...TEXT_ENTRY_ROUTES].sort());
});
