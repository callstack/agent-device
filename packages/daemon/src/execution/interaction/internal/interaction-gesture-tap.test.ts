import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  makeIosSession,
  makeAndroidSession,
  authoringPublication,
} from '../../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { touchCreateCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';
import {
  registerRequestAbort,
  markRequestCanceled,
  clearRequestCanceled,
} from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { clearAndroidObservationFixture } from '../../../__tests__/support/android-observation-fixture.ts';
import { handleInteractionCommands } from '../index.ts';
import { makeTestScreenRecordingResource } from '../../../__tests__/support/screen-recording-live-handle.ts';
import { gestureRuntimeBindingsFixture } from './__tests__/gesture-runtime-bindings.fixtures.ts';

let gestures = gestureRuntimeBindingsFixture();
const requestId = 'tap-series-cancel';
const perform = vi.fn(async () => ({
  kind: 'tap' as const,
  pointerCount: 2 as const,
  durationMs: 40,
  from: { x: 140, y: 375 },
  to: { x: 140, y: 375 },
  message: 'Tapped 2 points',
}));

beforeEach(() => {
  gestures = gestureRuntimeBindingsFixture();
  perform.mockReset();
  registerRequestAbort(requestId);
});

afterEach(() => {
  clearRequestCanceled(requestId);
  vi.useRealTimers();
});

async function runGesture(
  input: Record<string, unknown>,
  command: 'gesture' | 'swipe' = 'gesture',
  androidObservation?: AndroidObservationAdapter,
) {
  const sessionStore = makeSessionStore();
  const session = (androidObservation ? makeAndroidSession : makeIosSession)('tap', {
    appBundleId: 'com.example.tap',
    scriptPublication: authoringPublication('armed'),
  });
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'simctl recordVideo',
    outPath: '/tmp/demo.mp4',
    startedAt: 1000,
    gestureClockOriginAtMs: 1000,
    gestureClockOriginUptimeMs: 100,
  });
  sessionStore.publish('tap', session);
  const response = await handleInteractionCommands({
    createCommandSurface: async (config) => {
      const surface = await touchCreateCommandSurface(config);
      return { ...surface, interactions: { ...surface.interactions, gesture: perform } };
    },
    platformServices: daemonPlatformServicesFixture(),
    androidObservation,
    req: {
      token: 't',
      session: 'tap',
      command,
      meta: { requestId },
      positionals: [],
      flags: {},
      input,
    },
    sessionName: 'tap',
    sessionStore,
    captureSnapshotForSession: async ({ session: ref }) => ref.snapshot!,
    contextFromFlags: () => ({}),
    inspectFacts: gestures.inspectFacts,
    bindDevice: gestures.bindDevice,
  });
  return {
    response,
    action: session.actions[0],
    actions: session.actions,
    events: session.screenRecording.handle.inspect().gestureEvents,
  };
}

test('a structured tap series records its contacts and series flags for .ad replay', async () => {
  const { response, action } = await runGesture({
    kind: 'tap',
    points: [
      { x: 80, y: 300 },
      { x: 200, y: 450 },
    ],
    holdMs: 40,
    count: 2,
    pauseMs: 10,
  });

  expect(response).toMatchObject({
    ok: true,
    data: {
      kind: 'tap',
      points: [
        { x: 80, y: 300 },
        { x: 200, y: 450 },
      ],
      holdMs: 40,
      count: 2,
      pauseMs: 10,
      message: 'Tapped 2 points 2 times',
    },
  });
  expect(response && 'data' in response ? response.data : undefined).not.toHaveProperty(
    'completed',
  );
  expect(perform).toHaveBeenCalledTimes(2);
  expect(perform).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      gesture: {
        intent: 'tap',
        points: [
          { x: 80, y: 300 },
          { x: 200, y: 450 },
        ],
        holdMs: 40,
      },
    }),
  );
  expect(gestures.bindDevice).toHaveBeenCalledTimes(1);
  expect(action).toMatchObject({
    command: 'gesture',
    positionals: ['tap', '80', '300', '200', '450'],
    flags: { holdMs: 40, count: 2, pauseMs: 10 },
  });
});

test('a tap without series inputs records no series flags', async () => {
  const { action } = await runGesture({
    kind: 'tap',
    points: [
      { x: 80, y: 300 },
      { x: 200, y: 450 },
    ],
  });

  expect(action?.flags).not.toHaveProperty('count');
  expect(action?.flags).not.toHaveProperty('holdMs');
  expect(action?.flags).not.toHaveProperty('pauseMs');
});

function seriesInput(command: 'gesture' | 'swipe') {
  return command === 'gesture'
    ? {
        kind: 'tap',
        points: [
          { x: 80, y: 300 },
          { x: 200, y: 450 },
        ],
      }
    : { from: { x: 80, y: 300 }, to: { x: 200, y: 450 } };
}

for (const command of ['gesture', 'swipe'] as const) {
  test(`${command} cancellation interrupts a pause with its typed reason and records no action`, async () => {
    vi.useFakeTimers();
    const input = seriesInput(command);
    let outcome: Awaited<ReturnType<typeof runGesture>> | undefined;
    const pending = runGesture({ ...input, count: 3, pauseMs: 1000 }, command).then((result) => {
      outcome = result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(outcome).toBeUndefined();
    markRequestCanceled(requestId);
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(outcome?.response).toMatchObject({
        ok: false,
        error: { code: 'COMMAND_FAILED', details: { reason: 'request_canceled' } },
      });
      expect(outcome?.actions).toEqual([]);
      expect(outcome?.events).toHaveLength(command === 'gesture' ? 2 : 1);
      expect(perform).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      await pending;
    }
  });
}

for (const command of ['gesture', 'swipe'] as const) {
  test(`${command} keeps every completed overlay when the last execution cancels finalization`, async () => {
    const completed = await perform();
    perform.mockClear();
    perform.mockImplementation(async () => {
      if (perform.mock.calls.length === 3) markRequestCanceled(requestId);
      return completed;
    });
    const { response, actions, events } = await runGesture(
      { ...seriesInput(command), count: 3 },
      command,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_FAILED', details: { reason: 'request_canceled' } },
    });
    expect(actions).toEqual([]);
    expect(perform).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(command === 'gesture' ? 6 : 3);
  });

  test(`${command} records only completed executions when a later execution fails`, async () => {
    const completed = await perform();
    perform.mockClear();
    perform
      .mockResolvedValueOnce(completed)
      .mockRejectedValueOnce(
        new AppError('COMMAND_FAILED', 'Later execution failed', { reason: 'execution-failed' }),
      );
    const { response, actions, events } = await runGesture(
      { ...seriesInput(command), count: 3 },
      command,
    );
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'Later execution failed',
        details: { reason: 'execution-failed' },
      },
    });
    expect(actions).toEqual([]);
    expect(perform).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(command === 'gesture' ? 2 : 1);
  });

  test(`${command} records nothing when cancellation precedes dispatch`, async () => {
    markRequestCanceled(requestId);
    const { response, actions, events } = await runGesture(
      { ...seriesInput(command), count: 3 },
      command,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_FAILED', details: { reason: 'request_canceled' } },
    });
    expect(actions).toEqual([]);
    expect(events).toEqual([]);
    expect(perform).not.toHaveBeenCalled();
  });
}

for (const canceled of [false, true]) {
  test(`Android post-tap ANR recovery is ${canceled ? 'skipped after cancellation' : 'performed without cancellation'}`, async () => {
    let dispatched = false;
    const tap = vi.fn(clearAndroidObservationFixture.tap);
    const openApp = vi.fn(clearAndroidObservationFixture.openApp);
    const readBlockingDialog = vi.fn<AndroidObservationAdapter['readBlockingDialog']>(async () =>
      dispatched
        ? {
            status: 'dialog',
            focus: {
              package: 'com.example.tap',
              focusedWindow: 'Application Not Responding',
              raw: '',
            },
          }
        : { status: 'clear' },
    );
    const androidObservation: AndroidObservationAdapter = {
      ...clearAndroidObservationFixture,
      readBlockingDialog,
      readSnapshotNodes: async () => [
        {
          index: 0,
          ref: 'e0',
          type: 'Button',
          label: 'Close app',
          rect: { x: 10, y: 20, width: 100, height: 40 },
        },
      ],
      tap,
      openApp,
    };
    const result = await perform();
    perform.mockClear();
    perform.mockImplementation(async () => {
      dispatched = true;
      if (canceled) markRequestCanceled(requestId);
      return result;
    });
    const { response, actions } = await runGesture(
      {
        kind: 'tap',
        points: [
          { x: 80, y: 300 },
          { x: 200, y: 450 },
        ],
      },
      'gesture',
      androidObservation,
    );
    expect(perform).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ ok: false, error: { code: 'COMMAND_FAILED' } });
    if (canceled) {
      expect(response).toMatchObject({ error: { details: { reason: 'request_canceled' } } });
      expect(readBlockingDialog).toHaveBeenCalledTimes(1);
      expect(tap).not.toHaveBeenCalled();
      expect(openApp).not.toHaveBeenCalled();
    } else {
      expect(response && !response.ok ? response.error.details : undefined).not.toHaveProperty(
        'reason',
        'request_canceled',
      );
      expect(tap).toHaveBeenCalledTimes(1);
      expect(openApp).toHaveBeenCalledTimes(1);
    }
    expect(actions).toEqual([]);
  });
}

for (const command of ['gesture', 'swipe'] as const) {
  test(`${command} retains completed overlays when post-command cancellation prevents action recording`, async () => {
    let reads = 0;
    const androidObservation: AndroidObservationAdapter = {
      ...clearAndroidObservationFixture,
      readBlockingDialog: async () => {
        if (++reads === 2) markRequestCanceled(requestId);
        return { status: 'clear' };
      },
    };
    const { response, actions, events } = await runGesture(
      { ...seriesInput(command), count: 3 },
      command,
      androidObservation,
    );
    expect(reads).toBe(2);
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_FAILED', details: { reason: 'request_canceled' } },
    });
    expect(actions).toEqual([]);
    expect(perform).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(command === 'gesture' ? 6 : 3);
  });
}

for (const command of ['gesture', 'swipe'] as const) {
  for (const native of [false, true]) {
    test(`repeated ${command} records individual ${native ? 'native' : 'wall clock'} timing`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1100);
      let index = 0;
      perform.mockImplementation(async () => {
        const start = Date.now();
        const duration = [40, 60, 80][index++]!;
        await new Promise((resolve) => setTimeout(resolve, duration));
        return {
          kind: 'tap',
          pointerCount: 2,
          durationMs: native ? duration + 10 : duration,
          from: { x: 140, y: 375 },
          to: { x: 140, y: 375 },
          message: 'done',
          ...(native
            ? {
                backendResult: {
                  gestureStartUptimeMs: start - 900,
                  gestureEndUptimeMs: start - 900 + duration,
                },
              }
            : {}),
        };
      });
      const pending = runGesture(
        {
          ...seriesInput(command),
          count: 3,
          pauseMs: 100,
          ...(command === 'swipe' ? { pattern: 'ping-pong' } : {}),
        },
        command,
      );
      await vi.runAllTimersAsync();
      const { response, events, actions } = await pending;
      expect(response).toMatchObject({ ok: true, data: { durationMs: native ? 90 : 80 } });
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ command });
      expect(events.map(({ tMs, durationMs }) => ({ tMs, durationMs }))).toEqual(
        command === 'swipe'
          ? [
              { tMs: 100, durationMs: 40 },
              { tMs: 240, durationMs: 60 },
              { tMs: 400, durationMs: 80 },
            ]
          : [
              { tMs: 100, durationMs: 40 },
              { tMs: 100, durationMs: 40 },
              { tMs: 240, durationMs: 60 },
              { tMs: 240, durationMs: 60 },
              { tMs: 400, durationMs: 80 },
              { tMs: 400, durationMs: 80 },
            ],
      );
      expect(perform).toHaveBeenCalledTimes(3);
      expect(gestures.bindDevice).toHaveBeenCalledTimes(1);
      if (command === 'swipe') {
        expect(events).toMatchObject([
          { kind: 'swipe', x: 80, y: 300, x2: 200, y2: 450 },
          { kind: 'swipe', x: 200, y: 450, x2: 80, y2: 300 },
          { kind: 'swipe', x: 80, y: 300, x2: 200, y2: 450 },
        ]);
      }
    });
  }
}
