import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { expireRefFrame } from '../../ref-frame.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  contextFromFlags,
  createEmulateCaptureSnapshotForSession,
  makeAndroidSession,
} from './interaction-touch-fixtures.ts';

// How Android readiness composes with ref admission: the freshness refresh
// around a @ref action, the escape assertion, and blocking-dialog recovery.

type EnsureAndroidBlockingSystemDialogReady =
  typeof import('../../android-system-dialog.ts').ensureAndroidBlockingSystemDialogReady;

const { androidDialogReadiness } = vi.hoisted(() => ({
  androidDialogReadiness: {
    spy: vi.fn<EnsureAndroidBlockingSystemDialogReady>(),
    actual: undefined as unknown as EnsureAndroidBlockingSystemDialogReady,
  },
}));

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
  };
});

vi.mock('../../../platforms/android/app-lifecycle.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/app-lifecycle.ts')>();
  return {
    ...actual,
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogFocus: vi.fn(async () => null),
  };
});

vi.mock('../interaction-snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../interaction-snapshot.ts')>();
  return {
    ...actual,
    captureSnapshotForSession: vi.fn(async () => ({
      nodes: [],
      createdAt: 0,
      backend: 'xctest' as const,
    })),
  };
});

// The blocking-dialog readiness check runs for real (its focus probe is mocked
// above); the recovery regression below swaps in a recovering implementation.
vi.mock('../../android-system-dialog.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../android-system-dialog.ts')>();
  androidDialogReadiness.actual = actual.ensureAndroidBlockingSystemDialogReady;
  return { ...actual, ensureAndroidBlockingSystemDialogReady: androidDialogReadiness.spy };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
const mockDispatch = vi.mocked(dispatchCommand);
import {
  getAndroidAppState,
  getAndroidBlockingDialogFocus,
} from '../../../platforms/android/app-lifecycle.ts';
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogFocus = vi.mocked(getAndroidBlockingDialogFocus);
import { captureSnapshotForSession } from '../interaction-snapshot.ts';
const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotForSession);

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogFocus.mockReset();
  mockGetAndroidBlockingDialogFocus.mockResolvedValue(null);
  mockCaptureSnapshotForSession.mockReset();
  mockCaptureSnapshotForSession.mockImplementation(
    createEmulateCaptureSnapshotForSession(mockDispatch),
  );
  androidDialogReadiness.spy.mockReset();
  androidDialogReadiness.spy.mockImplementation((params) => androidDialogReadiness.actual(params));
});

test('press @ref refreshes Android snapshot when freshness tracking is active', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-fresh-ref-refresh';
  const session = makeAndroidSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 40, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: 1,
    routeComparable: false,
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command, args) => {
    if (command === 'snapshot') {
      return {
        nodes: [
          {
            index: 0,
            type: 'android.widget.Button',
            label: 'Continue',
            rect: { x: 100, y: 200, width: 80, height: 40 },
            enabled: true,
            hittable: true,
          },
        ],
        backend: 'android',
      };
    }
    return { pressed: true, args };
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1', 'Continue'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockCaptureSnapshotForSession.mock.calls[0]?.[4]).toEqual({
    interactiveOnly: true,
    androidFreshnessMode: 'ref-refresh',
  });
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['snapshot', 'press']);
  expect(mockDispatch.mock.calls[1]?.[2]).toEqual(['140', '220']);
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toMatchObject({
    action: 'press',
    baselineCount: 1,
    routeComparable: true,
  });
});

test('ADR 0014: Android freshness cannot retarget an admitted ref by positional coincidence', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-fresh-ref-no-retarget';
  const session = makeAndroidSession(sessionName);
  const frameTree = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 40, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android' as const,
    comparisonSafe: true,
  };
  session.snapshot = frameTree;
  // ADR 0014: the authorized frame tree names WHICH node @e1 authorizes.
  session.refFrameTree = frameTree;
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: 1,
    routeComparable: false,
  };
  sessionStore.set(sessionName, session);

  // The freshness refresh returns a DIFFERENT element at @e1's index — after
  // navigation the button at that position is now "Cancel", not "Continue".
  mockDispatch.mockImplementation(async (_device, command, args) => {
    if (command === 'snapshot') {
      return {
        nodes: [
          {
            index: 0,
            type: 'android.widget.Button',
            label: 'Cancel',
            rect: { x: 100, y: 200, width: 80, height: 40 },
            enabled: true,
            hittable: true,
          },
        ],
        backend: 'android',
      };
    }
    return { pressed: true, args };
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  // The identity at @e1 changed (Continue -> Cancel), so the refreshed
  // observation must NOT redefine the target: the press stays on the frame
  // node's coordinates (center of {0,0,40,40}), never the fresh (140, 220).
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['snapshot', 'press']);
  expect(mockDispatch.mock.calls[1]?.[2]).toEqual(['20', '20']);
});

test('press @ref falls back to cached Android ref when freshness refresh fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-fresh-ref-refresh-failure';
  const session = makeAndroidSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: 1,
    routeComparable: true,
  };
  sessionStore.set(sessionName, session);

  mockCaptureSnapshotForSession.mockRejectedValueOnce(new Error('uiautomator timeout'));
  mockDispatch.mockResolvedValue({ pressed: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e1', 'Continue'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockCaptureSnapshotForSession).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['press']);
  expect(mockDispatch.mock.calls[0]?.[2]).toEqual(['60', '40']);
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toMatchObject({
    action: 'press',
    baselineCount: 1,
    routeComparable: true,
  });
});

test('coordinate press preserves Android route freshness from last comparable snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-coordinate-freshness-baseline';
  const session = makeAndroidSession(sessionName);
  const comparableSnapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.ScrollView',
        label: 'Albums',
        rect: { x: 0, y: 0, width: 400, height: 700 },
      },
      {
        index: 1,
        type: 'android.widget.Button',
        label: 'Go to Contacts',
        rect: { x: 16, y: 120, width: 160, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android' as const,
    comparisonSafe: true,
  };
  session.lastComparisonSafeSnapshot = comparableSnapshot;
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Go to Contacts',
        rect: { x: 16, y: 120, width: 160, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: false,
  };
  sessionStore.set(sessionName, session);
  mockDispatch.mockResolvedValue({ pressed: true });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['96', '144'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toMatchObject({
    action: 'press',
    baselineCount: 2,
    baselineSignatures: expect.any(Array),
    routeComparable: true,
  });
});

test('press @ref fails when Android tap escapes to launcher', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-escape';
  const session = makeAndroidSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Pay',
        rect: { x: 16, y: 40, width: 120, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ pressed: true });
  mockGetAndroidAppState.mockResolvedValue({
    package: 'com.google.android.apps.nexuslauncher',
    activity: 'Launcher',
  });

  await expect(
    handleInteractionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'press',
        positionals: ['@e1'],
        flags: {},
      },
      sessionName,
      sessionStore,
      contextFromFlags,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('tap likely escaped the app'),
  });
  expect(sessionStore.get(sessionName)?.actions).toEqual([]);
});

test('press @ref fails when Android tap escapes to Settings', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-settings-escape';
  const session = makeAndroidSession(sessionName);
  session.appBundleId = 'com.agentdevice.tester';
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Open Adam',
        rect: { x: 16, y: 40, width: 120, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({ pressed: true });
  mockGetAndroidAppState.mockResolvedValue({
    package: 'com.android.settings',
    activity: 'Settings',
  });

  await expect(
    handleInteractionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'press',
        positionals: ['@e1'],
        flags: {},
      },
      sessionName,
      sessionStore,
      contextFromFlags,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('foregrounded com.android.settings'),
  });
});

const ANDROID_PERMISSION_PROMPT_PACKAGES = [
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  'com.google.android.packageinstaller',
  'com.android.packageinstaller',
] as const;

test.each(ANDROID_PERMISSION_PROMPT_PACKAGES)(
  'press @ref succeeds with a pending-alert warning when %s foregrounds',
  async (packageName) => {
    const sessionStore = makeSessionStore();
    const sessionName = 'android-permission-prompt';
    const session = makeAndroidSession(sessionName);
    session.snapshot = {
      nodes: attachRefs([
        {
          index: 0,
          type: 'android.widget.Button',
          label: 'Request microphone',
          rect: { x: 16, y: 40, width: 120, height: 48 },
          enabled: true,
          hittable: true,
        },
      ]),
      createdAt: Date.now(),
      backend: 'android',
    };
    sessionStore.set(sessionName, session);

    mockDispatch.mockResolvedValue({ pressed: true });
    mockGetAndroidAppState.mockResolvedValue({
      package: packageName,
      activity: 'com.android.permissioncontroller.permission.ui.GrantPermissionsActivity',
    });

    const response = await handleInteractionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'press',
        positionals: ['@e1'],
        flags: {},
      },
      sessionName,
      sessionStore,
      contextFromFlags,
    });

    expect(response?.ok).toBe(true);
    if (response?.ok) {
      expect(response.data?.warning).toMatch(/opened an Android permission dialog/);
      expect(response.data?.warning).toMatch(/"alert get"/);
    }
    expect(sessionStore.get(sessionName)?.actions).toHaveLength(1);
  },
);

// ADR 0014 (evidence #13): Android blocking-dialog recovery is device-mutating
// and expires the frame at its own seam. A ref action admitted against the
// pre-recovery frame must ABORT after recovery mutates — it cannot continue
// against the recovered UI — and the rejection must use the SHARED admission
// shape (reason + ref + currentGeneration + scope), not a bespoke error.
test('a ref action aborts with the shared ref_frame_expired rejection after Android dialog recovery mutates', async () => {
  // Simulate recovery: the before-command readiness check taps a blocking dialog
  // (a device mutation) and reports `recovered`, expiring the frame.
  androidDialogReadiness.spy.mockImplementation(async (params) => {
    if (params.phase === 'before-command') {
      expireRefFrame(params.session);
      return { status: 'recovered', warning: 'Recovered from a blocking system dialog' };
    }
    return { status: 'clear' };
  });
  const sessionStore = makeSessionStore();
  const sessionName = 'android-recovery-abort';
  const session = makeAndroidSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 80, height: 80 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  session.snapshotGeneration = 900;
  // A freshly issued complete frame is active.
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: { token: 't', session: sessionName, command: 'press', positionals: ['@e1'], flags: {} },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    // The SHARED admission rejection shape — not a bespoke recovery error.
    const details = response.error.details as Record<string, unknown> | undefined;
    expect(details?.reason).toBe('ref_frame_expired');
    expect(details?.ref).toBe('@e1');
    expect(details?.currentGeneration).toBe(900);
    expect(details?.scope).toBe('all');
  }
  // The outstanding ref action never dispatched a press against the recovered UI.
  expect(mockDispatch.mock.calls.some((call) => call[1] === 'press')).toBe(false);
});
