import { test, expect, vi } from 'vitest';
import {
  attachRefs,
  type IosTargetActivation,
  type SnapshotState,
} from '@agent-device/kernel/snapshot';
import { iosTargetActivationDisclosure } from '@agent-device/contracts/ios-target-activation';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../../index.ts';
import { getRuntimeBindings } from '../../../__tests__/interaction-get-runtime-fixture.ts';
import { contextFromFlags, makeSession } from './interaction-touch-fixtures.ts';
import { legacyDispatchCapture } from '../../../__tests__/legacy-snapshot-capture-fixture.ts';
import { markDeferredInteractionOutcome } from '../../../deferred-interaction-outcome.ts';
import { formatGestureUnsettledWarning } from '@agent-device/capture-kit/post-gesture-stability';

vi.mock('../../../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

const FACT: IosTargetActivation = {
  reason: 'stale_target',
  priorState: 'runningBackground',
  otherActiveApplicationPid: 4562,
};

function capturedTree(params: {
  sessionName: string;
  targetActivation?: IosTargetActivation;
}): SnapshotState {
  return {
    nodes: attachRefs([
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
      {
        index: 1,
        parentIndex: 0,
        depth: 1,
        type: 'Cell',
        label: 'General',
        rect: { x: 16, y: 293, width: 370, height: 52 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
    ...(params.targetActivation ? { targetActivation: params.targetActivation } : {}),
  };
}

async function pressSelector(params: {
  sessionName: string;
  capture: SnapshotState;
  captureCalls: { count: number };
}) {
  const sessionStore = makeSessionStore();
  sessionStore.set(params.sessionName, makeSession(params.sessionName));
  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: params.sessionName,
      command: 'press',
      positionals: ['label="General"'],
      flags: {},
    },
    sessionName: params.sessionName,
    sessionStore,
    contextFromFlags,
    captureSnapshotForSession: async () => {
      params.captureCalls.count += 1;
      return params.capture;
    },
    ...getRuntimeBindings(),
  });
  return { response, stored: sessionStore.get(params.sessionName) };
}

/**
 * The interaction's target tree is the thing an agent believes it tapped. When the runner had to
 * re-activate the session app to serve that tree, the press response must say so (#2682).
 */
test('a press whose target capture repaired foreground discloses the repair', async () => {
  const captureCalls = { count: 0 };
  const { response } = await pressSelector({
    sessionName: 'default',
    capture: capturedTree({ sessionName: 'default', targetActivation: FACT }),
    captureCalls,
  });

  expect(captureCalls.count).toBeGreaterThan(0);
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warnings).toEqual([iosTargetActivationDisclosure(FACT)]);
    expect(response.data?.targetActivation).toEqual(FACT);
  }
});

/**
 * A press answered from the stored ref frame consumes no capture, so this request paid no
 * foreground repair. An older capture's fact must not be attributed to it.
 */
test('a press that consumes no capture is not disclosed against an older tree', async () => {
  const captureCalls = { count: 0 };
  const sessionName = 'default';
  const sessionStore = makeSessionStore();
  const session = makeSession(sessionName);
  session.snapshot = capturedTree({ sessionName, targetActivation: FACT });
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e2'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    captureSnapshotForSession: async () => {
      captureCalls.count += 1;
      return capturedTree({ sessionName });
    },
    ...getRuntimeBindings(),
  });

  expect(captureCalls.count).toBe(0);
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warnings).toBeUndefined();
    expect(response.data?.targetActivation).toBeUndefined();
  }
});

/**
 * A press by selector after a scroll whose list never stops: the post-gesture capture misses on a
 * surface still moving, and the full-tree retry right after it proves nothing about the surface
 * having stopped. The miss must not read as a definite absence.
 */
test('a press that misses on a surface still moving after a scroll reports the unsettled fact', async () => {
  const sessionStore = makeSessionStore();
  const session = makeSession('default');
  markDeferredInteractionOutcome({ session, command: 'scroll', positionals: ['down'], flags: {} });
  sessionStore.set('default', session);
  let call = 0;
  legacyDispatchCapture.mockImplementation(async () => {
    call += 1;
    return {
      backend: 'xctest',
      nodes: [
        { index: 0, depth: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
        {
          index: 1,
          parentIndex: 0,
          depth: 1,
          type: 'Cell',
          label: 'Wi-Fi',
          rect: { x: 16, y: 600 - call * 37, width: 370, height: 52 },
          hittable: true,
        },
      ],
    };
  });
  const realSetTimeout = globalThis.setTimeout;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let done = false;
  const pending = handleInteractionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'press',
      positionals: ['label="General"'],
      flags: {},
    },
    sessionName: 'default',
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  }).finally(() => (done = true));
  // The route awaits real I/O between polls, so the faked clock advances while the test yields.
  while (!done) {
    await vi.advanceTimersByTimeAsync(50);
    await new Promise((resolve) => realSetTimeout(resolve, 1));
  }
  const response = await pending;
  vi.useRealTimers();

  const gesture = { action: 'scroll', positionals: ['down'] };
  expect(response?.ok === false && response.error).toMatchObject({
    hint: expect.stringContaining(formatGestureUnsettledWarning(gesture)),
    details: { reason: 'selector_not_found', unsettledGesture: gesture },
  });
});
