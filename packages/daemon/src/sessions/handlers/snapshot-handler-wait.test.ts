import { test, expect, beforeEach } from 'vitest';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import { AppError } from '@agent-device/kernel/errors';
import { buildSnapshotPresentationKey } from '@agent-device/kernel/snapshot';
import { forwardingCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { legacyDispatchCapture } from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import {
  resetSnapshotRuntimeFixture,
  snapshotRuntimeFixture,
} from '../../__tests__/support/snapshot-runtime-fixture.ts';
import type { SessionState } from '../../core/session-state.ts';
import {
  androidCapture,
  androidDevice,
  androidTextRows,
  batteryCapture,
  handleSnapshotCommands,
  inboxBaselineNodes,
  inboxRow,
  locationRequiredCapture,
  makeAndroidFreshnessSession,
  makeSession,
  makeSessionStore,
  snapshotRequest,
} from '../../__tests__/support/handlers/snapshot-handler.fixtures.ts';

beforeEach(() => {
  resetSnapshotRuntimeFixture();
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
});

type WaitProbe = (
  backend: Parameters<CreateDaemonCommandSurface>[0]['backend'],
  context: { session: string; signal?: AbortSignal },
) => Promise<void>;

/**
 * A command surface whose `wait` is whatever the probe does with the daemon's selector backend:
 * the polling loop is the command family's, so these suites observe what the daemon contributes
 * around it — the capture the backend performs and the failure it decorates.
 */
function waitSurface(probe: WaitProbe): CreateDaemonCommandSurface {
  return async (config) => {
    const surface = await forwardingCreateCommandSurface(config);
    return {
      ...surface,
      selectors: {
        ...surface.selectors,
        wait: async (options) => {
          await probe(config.backend, {
            session: options.session ?? 'default',
            signal: config.signal,
          });
          return { waitedMs: 0, text: 'matched' } as never;
        },
      },
    };
  };
}

function timedOutWaitSurface(
  message: string,
  details: Record<string, unknown>,
): CreateDaemonCommandSurface {
  return waitSurface(async () => {
    throw new AppError('COMMAND_FAILED', message, details);
  });
}

async function captureOnce(backend: Parameters<WaitProbe>[0], session: string) {
  await backend.captureSnapshot?.({ session }, { interactiveOnly: true });
}

async function runWaitCommand(params: {
  sessionName: string;
  session: SessionState;
  createCommandSurface: CreateDaemonCommandSurface;
  positionals: string[];
}) {
  const sessionStore = makeSessionStore();
  sessionStore.publish(params.sessionName, params.session);
  const response = await handleSnapshotCommands({
    createCommandSurface: params.createCommandSurface,
    req: snapshotRequest(params.sessionName, 'wait', { positionals: params.positionals }),
    sessionName: params.sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    ...snapshotRuntimeFixture(),
  });
  return { response, sessionStore };
}

const locationPermissionNodes = [
  {
    index: 0,
    depth: 0,
    type: 'android.widget.FrameLayout',
    label: 'Location permission',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'android.widget.TextView',
    label: 'Allow location access?',
    rect: { x: 24, y: 210, width: 342, height: 40 },
  },
  {
    index: 2,
    depth: 1,
    parentIndex: 0,
    type: 'android.widget.Button',
    label: 'Not now',
    rect: { x: 24, y: 320, width: 140, height: 48 },
    hittable: true,
  },
  {
    index: 3,
    depth: 1,
    parentIndex: 0,
    type: 'android.widget.Button',
    label: 'Continue',
    rect: { x: 180, y: 320, width: 160, height: 48 },
    hittable: true,
  },
];

test('wait text on Android captures through the freshness-aware daemon capture', async () => {
  const sessionName = 'android-wait-freshness';
  legacyDispatchCapture
    .mockResolvedValueOnce(
      androidCapture(androidTextRows(18, inboxRow), { rawNodeCount: 18, maxDepth: 1 }),
    )
    .mockResolvedValueOnce(
      androidCapture(
        [
          { index: 0, depth: 0, type: 'android.widget.TextView', label: 'Create document' },
          { index: 1, depth: 0, type: 'android.widget.TextView', label: 'Done' },
        ],
        { rawNodeCount: 2, maxDepth: 1 },
      ),
    );

  const { response, sessionStore } = await runWaitCommand({
    sessionName,
    session: makeAndroidFreshnessSession(sessionName, 'press', inboxBaselineNodes(18)),
    createCommandSurface: waitSurface(async (backend) => await captureOnce(backend, sessionName)),
    positionals: ['Create document', '500'],
  });

  expect(response?.ok).toBe(true);
  expect(legacyDispatchCapture).toHaveBeenCalledTimes(2);
  expect(sessionStore.get(sessionName)?.snapshot?.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Create document' })]),
  );
});

test('wait bypasses a fresh matching session snapshot and captures the device', async () => {
  const sessionName = 'android-wait-fresh-capture';
  const session = makeSession(sessionName, androidDevice);
  session.snapshot = {
    createdAt: Date.now(),
    presentationKey: buildSnapshotPresentationKey({}),
    nodes: [{ ref: 'e1', index: 0, type: 'android.widget.TextView', label: 'Ready' }],
  };
  legacyDispatchCapture.mockResolvedValue({
    nodes: [{ index: 0, type: 'android.widget.TextView', label: 'Ready' }],
  });

  const { response } = await runWaitCommand({
    sessionName,
    session,
    createCommandSurface: waitSurface(async (backend) => await captureOnce(backend, sessionName)),
    positionals: ['label="Ready"', '5000'],
  });

  expect(response?.ok).toBe(true);
  expect(legacyDispatchCapture).toHaveBeenCalledWith(
    expect.anything(),
    'snapshot',
    [],
    undefined,
    expect.anything(),
  );
});

test('a timed-out wait names the compact current surface with its labels and buttons', async () => {
  const sessionName = 'android-wait-timeout-surface';
  legacyDispatchCapture.mockResolvedValue({
    nodes: locationPermissionNodes,
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 4, maxDepth: 1 },
  });

  const { response } = await runWaitCommand({
    sessionName,
    session: makeSession(sessionName, androidDevice),
    createCommandSurface: timedOutWaitSurface('wait timed out for text: Receipt uploaded', {
      reason: 'wait_target_absent',
    }),
    positionals: ['Receipt uploaded', '50'],
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe(
      'wait timed out for text: Receipt uploaded. Current surface: Location permission, Allow location access?, Not now, Continue.',
    );
    expect(response.error.details?.currentSurface).toEqual({
      labels: ['Location permission', 'Allow location access?', 'Not now', 'Continue'],
      buttons: ['Not now', 'Continue'],
    });
  }
});

test('a timed-out selector wait names the current surface the same way', async () => {
  const sessionName = 'android-wait-selector-timeout-surface';
  legacyDispatchCapture.mockResolvedValue(locationRequiredCapture());

  const { response } = await runWaitCommand({
    sessionName,
    session: makeSession(sessionName, androidDevice),
    createCommandSurface: timedOutWaitSurface('wait timed out for selector: id=receipt-uploaded', {
      reason: 'wait_target_absent',
    }),
    positionals: ['id=receipt-uploaded', '50'],
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe(
      'wait timed out for selector: id=receipt-uploaded. Current surface: Location required, Dismiss.',
    );
    expect(response.error.details?.currentSurface).toEqual({
      labels: ['Location required', 'Dismiss'],
      buttons: ['Dismiss'],
    });
  }
});

test('a wait that never read a capture leaves its failure undecorated and captures nothing', async () => {
  const sessionName = 'android-wait-timeout-surface-fails';
  legacyDispatchCapture.mockResolvedValue(batteryCapture());

  const { response } = await runWaitCommand({
    sessionName,
    session: makeSession(sessionName, androidDevice),
    createCommandSurface: timedOutWaitSurface('wait timed out for text: Receipt uploaded', {
      reason: 'wait_capture_stalled',
      retriable: true,
      readableCaptures: 0,
    }),
    positionals: ['Receipt uploaded', '0'],
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe('wait timed out for text: Receipt uploaded');
    expect(response.error.details?.reason).toBe('wait_capture_stalled');
    expect(response.error.details?.retriable).toBe(true);
    expect(response.error.details?.readableCaptures).toBe(0);
  }
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
});
