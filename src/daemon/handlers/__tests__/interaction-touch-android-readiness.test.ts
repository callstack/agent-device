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

// The Android device state a dispatch has to survive: an escape to launcher or
// Settings fails the press, a permission prompt warns instead, and
// blocking-dialog recovery aborts an admitted @ref rather than retargeting it.

type EnsureAndroidBlockingSystemDialogReady =
  typeof import('../../android-system-dialog.ts').ensureAndroidBlockingSystemDialogReady;

const { androidDialogReadiness } = vi.hoisted(() => ({
  androidDialogReadiness: {
    spy: vi.fn<EnsureAndroidBlockingSystemDialogReady>(),
    actual: undefined as unknown as EnsureAndroidBlockingSystemDialogReady,
  },
}));

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})) };
});

vi.mock('../../../platforms/android/input-actions.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/input-actions.ts')>();
  return { ...actual, getAndroidScreenSize: vi.fn(async () => ({ width: 1344, height: 2992 })) };
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

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

// The blocking-dialog readiness check runs for real (its focus probe is mocked
// above); the recovery regression below swaps in a recovering implementation.
vi.mock('../../android-system-dialog.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../android-system-dialog.ts')>();
  androidDialogReadiness.actual = actual.ensureAndroidBlockingSystemDialogReady;
  return { ...actual, ensureAndroidBlockingSystemDialogReady: androidDialogReadiness.spy };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
import {
  getAndroidAppState,
  getAndroidBlockingDialogFocus,
} from '../../../platforms/android/app-lifecycle.ts';
import { getAndroidScreenSize } from '../../../platforms/android/input-actions.ts';
import { captureSnapshotForSession } from '../interaction-snapshot.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogFocus = vi.mocked(getAndroidBlockingDialogFocus);
const mockGetAndroidScreenSize = vi.mocked(getAndroidScreenSize);
const mockCaptureSnapshotForSession = vi.mocked(captureSnapshotForSession);

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogFocus.mockReset();
  mockGetAndroidBlockingDialogFocus.mockResolvedValue(null);
  mockGetAndroidScreenSize.mockReset();
  mockGetAndroidScreenSize.mockResolvedValue({ width: 1344, height: 2992 });
  mockCaptureSnapshotForSession.mockReset();
  mockCaptureSnapshotForSession.mockImplementation(
    createEmulateCaptureSnapshotForSession(mockDispatch),
  );
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
  androidDialogReadiness.spy.mockReset();
  androidDialogReadiness.spy.mockImplementation((params) => androidDialogReadiness.actual(params));
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
