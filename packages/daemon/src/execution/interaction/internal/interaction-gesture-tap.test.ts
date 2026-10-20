import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  makeIosSession,
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
import { handleInteractionCommands } from '../index.ts';
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
  perform.mockClear();
  registerRequestAbort(requestId);
});

afterEach(() => {
  clearRequestCanceled(requestId);
  vi.useRealTimers();
});

async function runGesture(
  input: Record<string, unknown>,
  command: 'gesture' | 'swipe' = 'gesture',
) {
  const sessionStore = makeSessionStore();
  const session = makeIosSession('tap', {
    appBundleId: 'com.example.tap',
    scriptPublication: authoringPublication('armed'),
  });
  sessionStore.publish('tap', session);
  const response = await handleInteractionCommands({
    createCommandSurface: async (config) => {
      const surface = await touchCreateCommandSurface(config);
      return { ...surface, interactions: { ...surface.interactions, gesture: perform } };
    },
    platformServices: daemonPlatformServicesFixture(),
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
  return { response, action: session.actions[0], actions: session.actions };
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

for (const command of ['gesture', 'swipe'] as const) {
  test(`${command} cancellation interrupts a pause with its typed reason and records no action`, async () => {
    vi.useFakeTimers();
    const input =
      command === 'gesture'
        ? {
            kind: 'tap',
            points: [
              { x: 80, y: 300 },
              { x: 200, y: 450 },
            ],
          }
        : { from: { x: 80, y: 300 }, to: { x: 200, y: 450 } };
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
      expect(perform).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      await pending;
    }
  });
}

test('cancellation during the last tap records no completed action', async () => {
  let performed = 0;
  perform.mockImplementation(async () => {
    if (++performed === 3) markRequestCanceled(requestId);
    return {
      kind: 'tap',
      pointerCount: 2,
      durationMs: 40,
      from: { x: 140, y: 375 },
      to: { x: 140, y: 375 },
      message: 'Tapped 2 points',
    };
  });
  const { response, actions } = await runGesture({
    kind: 'tap',
    points: [
      { x: 80, y: 300 },
      { x: 200, y: 450 },
    ],
    count: 3,
  });
  expect(response).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'request_canceled' } },
  });
  expect(actions).toEqual([]);
  expect(performed).toBe(3);
});
