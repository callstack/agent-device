import fs from 'node:fs';
import { test, expect, beforeEach } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { legacyDispatchCapture } from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { forwardingCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { SessionStore } from '../../core/session-store.ts';
import {
  fixtureScreenshotCaptures,
  resetSnapshotRuntimeFixture,
} from '../../__tests__/support/snapshot-runtime-fixture.ts';
import {
  androidCapture,
  androidDevice,
  androidTextRows,
  handleSnapshotCommands,
  inboxBaselineNodes,
  inboxRow,
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

function makeAndroidTimeoutEvidenceSession(sessionName: string): SessionStore {
  const sessionStore = makeSessionStore();
  const session = makeSession(sessionName, androidDevice);
  session.snapshot = {
    nodes: [
      {
        ref: 'e1',
        index: 0,
        depth: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        hittable: true,
        rect: { x: 20, y: 40, width: 120, height: 48 },
      },
    ],
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.publish(sessionName, session);
  return sessionStore;
}

function mockAndroidTimeoutEvidenceDispatch(): void {
  legacyDispatchCapture.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') throw androidSnapshotTimeoutError();
    return {};
  });
}

function androidSnapshotTimeoutError(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Android snapshot helper timed out while waiting for the UI to become idle.',
    {
      cmd: 'adb',
      args: ['shell', 'am', 'instrument'],
      androidCaptureFailureReason: 'accessibility-timeout',
      hint: 'Android accessibility snapshots can be blocked by busy or continuously changing app UI. Use screenshot as visual truth after this timeout.',
    },
  );
}

function expectAndroidTimeoutEvidence(
  response: Awaited<ReturnType<typeof handleSnapshotCommands>>,
) {
  if (!response) throw new Error('Expected snapshot response');
  if (response.ok) throw new Error('Expected snapshot timeout failure');
  expect(response.error.message).toMatch(/snapshot helper timed out/i);
  expect(response.error.hint).toMatch(/Use screenshot as visual truth/i);
  assertAndroidTimeoutEvidencePayload(response.error.details?.androidSnapshotTimeoutScreenshot);
}

function assertAndroidTimeoutEvidencePayload(evidence: unknown) {
  if (!evidence || typeof evidence !== 'object') {
    throw new Error('Expected Android snapshot timeout screenshot evidence');
  }
  const record = evidence as Record<string, unknown>;
  expect(record.path).toEqual(expect.stringContaining('snapshot-timeout-overlay-refs.png'));
  expect(fs.existsSync(record.path as string)).toBe(true);
  expect(record.overlayRefsAnnotated).toBe(true);
  expect(record.overlayRefs).toEqual([expect.objectContaining({ ref: 'e1', label: 'Continue' })]);
}

test('snapshot timeout captures Android screenshot evidence with overlay refs', async () => {
  const sessionName = 'android-timeout-evidence';
  const sessionStore = makeAndroidTimeoutEvidenceSession(sessionName);
  mockAndroidTimeoutEvidenceDispatch();
  const response = await handleSnapshotCommands({
    createCommandSurface: forwardingCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'snapshot'),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });
  expectAndroidTimeoutEvidence(response);
  expect(legacyDispatchCapture.mock.calls.map((call) => call[1])).toEqual(['snapshot']);
  expect(fixtureScreenshotCaptures.at(-1)?.options).toMatchObject({ stabilize: false });
});

test('snapshot automatically retries stale Android trees after recent navigation', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-stale-retries-to-fresh';
  const session = makeAndroidFreshnessSession(sessionName, 'press', inboxBaselineNodes(24));
  sessionStore.publish(sessionName, session);

  legacyDispatchCapture
    .mockResolvedValueOnce(
      androidCapture(androidTextRows(24, inboxRow), { rawNodeCount: 24, maxDepth: 2 }),
    )
    .mockResolvedValueOnce(
      androidCapture(
        [
          { index: 0, depth: 0, type: 'android.widget.TextView', label: 'Create document' },
          { index: 1, depth: 0, type: 'android.widget.Button', label: 'Submit', hittable: true },
        ],
        { rawNodeCount: 2, maxDepth: 1 },
      ),
    );

  const response = await handleSnapshotCommands({
    createCommandSurface: forwardingCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'snapshot', { flags: { snapshotInteractiveOnly: true } }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(legacyDispatchCapture).toHaveBeenCalledTimes(2);
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toBeUndefined();
});

test.each([
  { route: 'snapshot', name: 'snapshot' },
  { route: 'diff', name: 'diff snapshot' },
] as const)(
  '$name gives up on a stale Android tree after three automatic retries',
  async ({ route }) => {
    const sessionStore = makeSessionStore();
    const sessionName = `android-stale-after-press-${route}`;
    const session = makeAndroidFreshnessSession(sessionName, 'press', inboxBaselineNodes(24));
    sessionStore.publish(sessionName, session);

    legacyDispatchCapture.mockResolvedValue(
      androidCapture(androidTextRows(24, inboxRow), { rawNodeCount: 24, maxDepth: 2 }),
    );

    const response = await handleSnapshotCommands({
      createCommandSurface: forwardingCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      req: snapshotRequest(sessionName, route, {
        ...(route === 'diff' ? { positionals: ['snapshot'] } : {}),
        flags: { snapshotInteractiveOnly: true },
      }),
      sessionName,
      logPath: '/tmp/daemon.log',
      sessionStore,
    });

    expect(response?.ok).toBe(true);
    expect(legacyDispatchCapture).toHaveBeenCalledTimes(4);
  },
);
