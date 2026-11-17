/**
 * #1349 (ADR 0012 decision 3 extension): the wait dispatch seam.
 *
 * Record time: a selector wait that succeeds while the session is recording attaches
 * landmark-mode `target-v1` evidence to the recorded action, and the resolution payload
 * (`node`/`preActionNodes`) reaches neither the public response nor session history.
 *
 * Replay time: `internal.replayLandmarkGuard` is handed to the wait as its recorded landmark, and
 * the refusal the wait reports for impostor-only matches reaches the response with its details.
 * The polling loop that applies the guard belongs to the command family
 * (`runtime/wait-selector.test.ts`).
 */
import { test, expect, beforeEach } from 'vitest';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import { WAIT_LANDMARK_MISMATCH_REASON } from '@agent-device/contracts/replay';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { fakeCreateCommandSurface } from '../__tests__/support/command-surface-fake.ts';
import { snapshotRuntimeFixture } from '../__tests__/support/snapshot-runtime-fixture.ts';
import { makeSessionStore } from '../__tests__/support/store-factory.ts';
import { legacyDispatchCapture } from '../__tests__/support/legacy-snapshot-capture-fixture.ts';
import {
  makeAndroidSession,
  authoringPublication,
} from '../__tests__/support/session-factories.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import { dispatchWaitViaRuntime } from './wait-runtime.ts';

type WaitOptions = Parameters<
  Awaited<ReturnType<CreateDaemonCommandSurface>>['selectors']['wait']
>[0];

const waitCalls: WaitOptions[] = [];
let waitOutcome: () => Promise<Record<string, unknown>>;

const waitCreateCommandSurface: CreateDaemonCommandSurface = async (config) => {
  const surface = await fakeCreateCommandSurface(config);
  return {
    ...surface,
    selectors: {
      ...surface.selectors,
      wait: async (options) => {
        waitCalls.push(options);
        return (await waitOutcome()) as never;
      },
    },
  };
};

const detailScreenNodes: SnapshotNode[] = [
  {
    ref: 'e1',
    index: 0,
    depth: 0,
    type: 'FrameLayout',
    label: 'Detail Screen',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  {
    ref: 'e2',
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'TextView',
    label: 'Screen X',
    rect: { x: 0, y: 100, width: 390, height: 40 },
  },
];

beforeEach(() => {
  waitCalls.length = 0;
  legacyDispatchCapture.mockReset();
  waitOutcome = async () => ({
    kind: 'selector',
    selector: 'label="Screen X"',
    waitedMs: 0,
    node: detailScreenNodes[1],
    preActionNodes: detailScreenNodes,
  });
});

function waitReq(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 't',
    session: 'default',
    command: 'wait',
    positionals: ['label="Screen X"', '1000'],
    flags: {},
    ...overrides,
  } as DaemonRequest;
}

async function runWait(options: { recording?: boolean; req?: DaemonRequest } = {}) {
  const sessionStore = makeSessionStore();
  const session = makeAndroidSession(
    'default',
    options.recording ? { scriptPublication: authoringPublication('armed') } : {},
  );
  sessionStore.publish('default', session);
  const response = await dispatchWaitViaRuntime({
    createCommandSurface: waitCreateCommandSurface,
    req: options.req ?? waitReq(),
    sessionName: 'default',
    logPath: '/tmp/test.log',
    sessionStore,
    ...snapshotRuntimeFixture(),
  });
  return { response, sessionStore };
}

test('a recorded selector wait attaches landmark-mode target-v1 evidence and strips the resolution payload', async () => {
  const { response, sessionStore } = await runWait({ recording: true });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data).not.toHaveProperty('node');
    expect(response.data).not.toHaveProperty('preActionNodes');
  }

  const recordedAction = sessionStore.get('default')?.actions[0];
  expect(recordedAction?.command).toBe('wait');
  expect(recordedAction?.targetEvidence).toMatchObject({
    role: 'textview',
    label: 'Screen X',
    ancestry: [{ role: 'framelayout', label: 'Detail Screen' }],
    verification: 'verified',
  });
  expect(recordedAction?.result).not.toHaveProperty('node');
  expect(recordedAction?.result).not.toHaveProperty('preActionNodes');
});

test('a selector wait without recording never computes target-v1 evidence', async () => {
  const { response, sessionStore } = await runWait({ recording: false });

  expect(response.ok).toBe(true);
  const recordedAction = sessionStore.get('default')?.actions[0];
  expect(recordedAction?.command).toBe('wait');
  expect(recordedAction?.targetEvidence).toBeUndefined();
});

function recordedLandmark(): TargetAnnotationV1 {
  return {
    role: 'textview',
    label: 'Screen X',
    ancestry: [{ role: 'framelayout', label: 'Detail Screen' }],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  };
}

test('a replayed wait hands its recorded landmark to the selector wait', async () => {
  const landmark = recordedLandmark();

  const { response } = await runWait({
    req: waitReq({ internal: { replayLandmarkGuard: landmark } }),
  });

  expect(response.ok).toBe(true);
  expect(waitCalls).toHaveLength(1);
  expect(waitCalls[0]?.target).toMatchObject({
    kind: 'selector',
    selector: 'label="Screen X"',
    recordedLandmark: landmark,
  });
});

test('a live wait hands the selector wait no recorded landmark', async () => {
  await runWait();

  expect(waitCalls[0]?.target).not.toHaveProperty('recordedLandmark');
});

test('a landmark refusal from the wait reaches the response with its details', async () => {
  waitOutcome = async () => {
    throw new AppError('COMMAND_FAILED', 'wait found only impostors of the recorded landmark', {
      reason: WAIT_LANDMARK_MISMATCH_REASON,
      matchCount: 1,
    });
  };

  const { response } = await runWait({
    req: waitReq({
      positionals: ['label="Screen X"', '600'],
      internal: { replayLandmarkGuard: recordedLandmark() },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.details?.reason).toBe(WAIT_LANDMARK_MISMATCH_REASON);
  expect(response.error.details?.matchCount).toBe(1);
});

// #1800: this seam is what BOTH a live CLI wait and a replayed `.ad` wait step
// dispatch through, so the selector-shaped-text rejection has to happen here,
// before any device/session work — not just in the CLI-only reader.
test('a selector-shaped positional list that fails to parse as a selector is rejected before dispatch', async () => {
  const { response } = await runWait({
    req: waitReq({ positionals: ['open', 'label="Open"', '25000'] }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toContain('label="Open"');
  expect(waitCalls).toEqual([]);
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
});
