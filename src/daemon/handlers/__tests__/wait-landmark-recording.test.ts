/**
 * #1349 (ADR 0012 decision 3 extension): the wait dispatch seam.
 *
 * Record time: a selector wait that succeeds while the session is recording
 * attaches landmark-mode `target-v1` evidence to the recorded action, and the
 * resolution payload (`node`/`preActionNodes`) reaches neither the public
 * response nor session history.
 *
 * Replay time: `internal.replayLandmarkGuard` threads the recorded landmark
 * into the real polling loop — success requires an identity-carrying match,
 * and a timeout with only impostor matches surfaces the
 * `WAIT_LANDMARK_MISMATCH_REASON` refusal.
 */
import { test, expect, vi, beforeEach } from 'vitest';
import { legacyDispatchCapture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { dispatchWaitViaRuntime } from '../../selector-runtime.ts';
import type { DaemonRequest } from '../../types.ts';
import { WAIT_LANDMARK_MISMATCH_REASON } from '@agent-device/contracts/replay';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import { snapshotRuntimeFixture } from '../../__tests__/snapshot-runtime-fixture.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import {
  makeAndroidSession,
  authoringPublication,
} from '../../../__tests__/test-utils/session-factories.ts';

vi.mock('../../../core/dispatch-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch-resolve.ts')>();
  return {
    ...actual,
    resolveTargetDevice: vi.fn(actual.resolveTargetDevice),
  };
});

vi.mock('../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

vi.mock('../../device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));

function screenSnapshot(parentLabel: string) {
  return {
    backend: 'android',
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'FrameLayout',
        label: parentLabel,
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'TextView',
        label: 'Screen X',
        rect: { x: 0, y: 100, width: 390, height: 40 },
      },
    ],
  };
}

beforeEach(() => {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockImplementation(async (_device: unknown, command: string) => {
    return command === 'snapshot' ? screenSnapshot('Detail Screen') : {};
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
  sessionStore.set('default', session);
  const response = await dispatchWaitViaRuntime({
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

test('a replayed wait with a landmark guard succeeds when a match carries the recorded identity', async () => {
  const { response } = await runWait({
    req: waitReq({ internal: { replayLandmarkGuard: recordedLandmark() } }),
  });

  expect(response.ok).toBe(true);
});

test('a replayed wait with a landmark guard refuses at the deadline when only impostors matched', async () => {
  legacyDispatchCapture.mockImplementation(async (_device: unknown, command: string) => {
    return command === 'snapshot' ? screenSnapshot('List Screen') : {};
  });

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
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
});
