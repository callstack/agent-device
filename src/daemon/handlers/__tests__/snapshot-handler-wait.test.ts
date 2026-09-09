import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { legacyDispatchCapture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { resetGetRuntimeFixture } from '../../__tests__/interaction-get-runtime-fixture.ts';
import { setActiveProviderDeviceRuntimes } from '../../../provider-device-runtime.ts';
import type { SessionState } from '../../session-state.ts';
import { buildSnapshotPresentationKey } from '@agent-device/kernel/snapshot';
import {
  resetSnapshotRuntimeFixture,
  snapshotRuntimeFixture,
} from '../../__tests__/snapshot-runtime-fixture.ts';
import {
  androidCapture,
  androidDevice,
  androidTextRows,
  batteryCapture,
  handleSnapshotCommands,
  inboxBaselineNodes,
  inboxRow,
  iosSimulatorDevice,
  locationRequiredCapture,
  makeAndroidFreshnessSession,
  makeSession,
  makeSessionStore,
  snapshotRequest,
} from './snapshot-handler.fixtures.ts';

vi.mock('../../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, runAppleRunnerCommand: vi.fn(async () => ({})) };
});

// The real implementation shells out to simctl to probe for a hint-worthy
// unambiguous environment; that live-probe logic is covered by
// ios-app-session-hint.test.ts. Stubbed here so this suite stays hermetic and
// fast — defaults to "no enrichment", matching the current-behavior fallback.
vi.mock('../../ios-app-session-hint.ts', () => ({
  buildIosOpenCommandHint: vi.fn(async () => undefined),
}));

import { runAppleRunnerCommand } from '@agent-device/platform-apple/runner/operations';
import { buildIosOpenCommandHint } from '../../ios-app-session-hint.ts';

const mockRunnerCommand = vi.mocked(runAppleRunnerCommand);
const mockBuildIosOpenCommandHint = vi.mocked(buildIosOpenCommandHint);

// An Apple wait runs inside an opened app: that bundle id is XCUITest's attach target, and
// without one the plan asks for the without-active-app row local Apple refuses.
const appAttach = (d: SessionState['device']): Partial<SessionState> =>
  d.platform === 'apple' ? { appBundleId: 'com.example.app' } : {};

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
});

beforeEach(() => {
  resetSnapshotRuntimeFixture();
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  resetGetRuntimeFixture();
  mockRunnerCommand.mockReset();
  mockRunnerCommand.mockResolvedValue({});
  mockBuildIosOpenCommandHint.mockReset();
  mockBuildIosOpenCommandHint.mockResolvedValue(undefined);
});

async function runWaitCommand(
  sessionName: string,
  device: SessionState['device'],
  positionals: string[],
) {
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName, device, appAttach(device)));
  return await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'wait', { positionals }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    ...snapshotRuntimeFixture(),
  });
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

const iosSurfaceSummaryNodes = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    label: 'Expo Go',
    rect: { x: 0, y: 0, width: 393, height: 852 },
  },
  {
    index: 1,
    depth: 1,
    type: 'XCUIElementTypeImage',
    label: 'gearshape.fill',
    rect: { x: 12, y: 54, width: 24, height: 24 },
  },
  {
    index: 2,
    depth: 1,
    type: 'XCUIElementTypeOther',
    label: 'Tab Bar',
    rect: { x: 0, y: 760, width: 393, height: 92 },
  },
  {
    index: 3,
    depth: 1,
    type: 'XCUIElementTypeStaticText',
    label: 'Confirm catalog refresh',
    rect: { x: 48, y: 280, width: 297, height: 36 },
  },
  {
    index: 4,
    depth: 1,
    type: 'XCUIElementTypeButton',
    label: 'Keep browsing',
    rect: { x: 48, y: 360, width: 297, height: 48 },
  },
  {
    index: 5,
    depth: 1,
    type: 'XCUIElementTypeButton',
    identifier: 'host.exp.exponent:id/reload_button',
    rect: { x: 260, y: 54, width: 48, height: 48 },
  },
];

test('wait text on Android uses freshness-aware capture instead of one-shot snapshot polling', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-wait-freshness';
  const session = makeAndroidFreshnessSession(sessionName, 'press', inboxBaselineNodes(18));
  sessionStore.set(sessionName, session);

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

  // The wait budget includes Android's 250 ms freshness retry delay.
  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'wait', { positionals: ['Create document', '500'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    ...snapshotRuntimeFixture(),
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.text).toBe('Create document');
  }
  expect(legacyDispatchCapture).toHaveBeenCalledTimes(2);
  expect(sessionStore.get(sessionName)?.snapshot?.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Create document' })]),
  );
});

test('wait text timeout includes compact current-surface labels and buttons', async () => {
  const sessionName = 'android-wait-timeout-surface';
  legacyDispatchCapture.mockResolvedValue({
    nodes: locationPermissionNodes,
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 4, maxDepth: 1 },
  });

  const response = await runWaitCommand(sessionName, androidDevice, ['Receipt uploaded', '50']);

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

test('wait selector timeout includes compact current-surface details', async () => {
  const sessionName = 'android-wait-selector-timeout-surface';
  legacyDispatchCapture.mockResolvedValue(locationRequiredCapture());

  const response = await runWaitCommand(sessionName, androidDevice, ['id=receipt-uploaded', '50']);

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

test('wait selector polling skips hidden-content hint derivation on every poll (#1270)', async () => {
  // The #1270 repro: `wait 'label="Battery"' 8000` on Android. A presence-only wait never
  // consumes scroll hints, so every per-poll snapshot capture must disable hint derivation —
  // otherwise a pathological `dumpsys activity top` call is charged against the wait budget.
  const sessionName = 'android-wait-selector-skips-hints';
  legacyDispatchCapture
    .mockResolvedValueOnce(locationRequiredCapture())
    .mockResolvedValueOnce(batteryCapture());

  const response = await runWaitCommand(sessionName, androidDevice, ['label="Battery"', '8000']);

  expect(response?.ok).toBe(true);
  const snapshotCalls = legacyDispatchCapture.mock.calls.filter(
    ([, command]) => command === 'snapshot',
  );
  expect(snapshotCalls.length).toBe(2);
  for (const call of snapshotCalls) {
    const context = call[4] as { snapshotIncludeHiddenContentHints?: boolean } | undefined;
    expect(context?.snapshotIncludeHiddenContentHints).toBe(false);
  }
});

test('wait text polling skips hidden-content hint derivation on every poll (#1270)', async () => {
  const sessionName = 'android-wait-text-skips-hints';
  legacyDispatchCapture
    .mockResolvedValueOnce(locationRequiredCapture())
    .mockResolvedValueOnce(batteryCapture());

  const response = await runWaitCommand(sessionName, androidDevice, ['Battery', '8000']);

  expect(response?.ok).toBe(true);
  const snapshotCalls = legacyDispatchCapture.mock.calls.filter(
    ([, command]) => command === 'snapshot',
  );
  expect(snapshotCalls.length).toBe(2);
  for (const call of snapshotCalls) {
    const context = call[4] as { snapshotIncludeHiddenContentHints?: boolean } | undefined;
    expect(context?.snapshotIncludeHiddenContentHints).toBe(false);
  }
});

test('wait timeout summary prefers content labels over chrome and identifier noise', async () => {
  const sessionName = 'ios-wait-timeout-surface-summary';
  mockRunnerCommand.mockResolvedValue({ found: false });
  legacyDispatchCapture.mockResolvedValue({
    nodes: iosSurfaceSummaryNodes,
    truncated: false,
    backend: 'xctest',
  });

  const response = await runWaitCommand(sessionName, iosSimulatorDevice, [
    'Impossible success text',
    '50',
  ]);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe(
      'wait timed out for text: Impossible success text. Current surface: Confirm catalog refresh, Keep browsing.',
    );
    expect(response.error.details?.currentSurface).toEqual({
      labels: [
        'Confirm catalog refresh',
        'Keep browsing',
        'host.exp.exponent:id/reload_button',
        'Expo Go',
        'gearshape.fill',
        'Tab Bar',
      ],
      buttons: ['Keep browsing', 'host.exp.exponent:id/reload_button'],
    });
  }
});

test('wait timeout without readable capture does not inspect the current surface', async () => {
  const sessionName = 'android-wait-timeout-surface-fails';
  legacyDispatchCapture.mockRejectedValue(new Error('snapshot unavailable'));

  const response = await runWaitCommand(sessionName, androidDevice, ['Receipt uploaded', '0']);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe('wait timed out for text: Receipt uploaded');
    expect(response.error.details?.reason).toBe('wait_capture_stalled');
    expect(response.error.details?.retriable).toBe(true);
    expect(response.error.details?.readableCaptures).toBe(0);
  }
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
});

test('wait selector bypasses a fresh matching session snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-wait-fresh-capture';
  const session = makeSession(sessionName, androidDevice);
  session.snapshot = {
    createdAt: Date.now(),
    presentationKey: buildSnapshotPresentationKey({}),
    nodes: [
      {
        ref: 'e1',
        index: 0,
        type: 'android.widget.TextView',
        label: 'Ready',
      },
    ],
  };
  sessionStore.set(sessionName, session);
  legacyDispatchCapture.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'android.widget.TextView',
        label: 'Ready',
      },
    ],
  });

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'wait', { positionals: ['label="Ready"', '5000'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    ...snapshotRuntimeFixture(),
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

test('wait sleep bypasses sessionless runner cleanup wrapper', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'wait', { positionals: ['0'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
});
