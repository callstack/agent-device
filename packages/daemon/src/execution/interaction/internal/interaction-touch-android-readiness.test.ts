import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { expireRefFrame } from '../../../core/ref-frame.ts';
import {
  installInteractorSnapshotResolution,
  mockInteractorSnapshot,
} from '../../../__tests__/support/interactor-resolution-fixture.ts';
import { touchCreateCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';
import {
  getRuntimeBindings,
  mockLongPressPoint,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../__tests__/interaction-get-runtime-fixture.ts';
import { contextFromFlags, makeAndroidSession } from './__tests__/interaction-touch-fixtures.ts';
import { handleInteractionCommands } from '../index.ts';

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

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    getAndroidScreenSize: vi.fn(async () => ({ width: 1344, height: 2992 })),
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

// The blocking-dialog readiness check runs for real (its focus probe is mocked
// above); the recovery regression below swaps in a recovering implementation.
vi.mock('../../android-system-dialog.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../android-system-dialog.ts')>();
  androidDialogReadiness.actual = actual.ensureAndroidBlockingSystemDialogReady;
  return { ...actual, ensureAndroidBlockingSystemDialogReady: androidDialogReadiness.spy };
});

import {
  getAndroidAppState,
  getAndroidBlockingDialogObservation,
  getAndroidScreenSize,
} from '@agent-device/platform-android/mechanics';
const mockGetAndroidAppState = vi.mocked(getAndroidAppState);
const mockGetAndroidBlockingDialogObservation = vi.mocked(getAndroidBlockingDialogObservation);
const mockGetAndroidScreenSize = vi.mocked(getAndroidScreenSize);

beforeEach(() => {
  resetGetRuntimeFixture();
  mockGetAndroidAppState.mockReset();
  mockGetAndroidAppState.mockResolvedValue({});
  mockGetAndroidBlockingDialogObservation.mockReset();
  mockGetAndroidBlockingDialogObservation.mockResolvedValue({ status: 'clear' });
  mockGetAndroidScreenSize.mockReset();
  mockGetAndroidScreenSize.mockResolvedValue({ width: 1344, height: 2992 });
  installInteractorSnapshotResolution();
  mockInteractorSnapshot.mockReset();
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
  sessionStore.publish(sessionName, session);

  mockTapPoint.mockResolvedValue({ pressed: true });
  mockGetAndroidAppState.mockResolvedValue({
    package: 'com.google.android.apps.nexuslauncher',
    activity: 'Launcher',
  });

  await expect(
    handleInteractionCommands({
      createCommandSurface: touchCreateCommandSurface,
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
      ...getRuntimeBindings(),
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
  sessionStore.publish(sessionName, session);

  mockTapPoint.mockResolvedValue({ pressed: true });
  mockGetAndroidAppState.mockResolvedValue({
    package: 'com.android.settings',
    activity: 'Settings',
  });

  await expect(
    handleInteractionCommands({
      createCommandSurface: touchCreateCommandSurface,
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
      ...getRuntimeBindings(),
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('foregrounded com.android.settings'),
  });
});

const LAUNCHER_PACKAGE = 'com.google.android.apps.nexuslauncher';

// #5034: a tap that opens another app flips the focused window only once the app transition lands.
// A guard read taken before that transition names the session app and passes on stale state. The
// after-command blocking-dialog readiness read already runs after the dispatch, so it is the later
// look at the same screen: when its focused window names another app, the guard decides on that
// evidence and spends no read of its own.
test('press @ref fails when only the after-command readiness read sees the escape to Settings', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-late-settings-escape';
  const session = makeAndroidSession(sessionName);
  session.appBundleId = 'com.example.app';
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Open Settings',
        rect: { x: 16, y: 40, width: 120, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.publish(sessionName, session);

  mockTapPoint.mockResolvedValue({ pressed: true });
  // The pre-dispatch readiness read names the session app; the post-dispatch one already names
  // Settings. The guard's OWN read models the measured transition: the first `dumpsys window` after
  // `input tap` still names the app (#5034), so the early guard passes on that stale answer.
  mockGetAndroidBlockingDialogObservation
    .mockResolvedValueOnce({ status: 'clear', focusedPackage: 'com.example.app' })
    .mockResolvedValueOnce({ status: 'clear', focusedPackage: 'com.android.settings' });
  mockGetAndroidAppState.mockResolvedValue({
    package: 'com.example.app',
    activity: 'Main',
  });

  await expect(
    handleInteractionCommands({
      createCommandSurface: touchCreateCommandSurface,
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
      ...getRuntimeBindings(),
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('foregrounded com.android.settings'),
    details: {
      expectedPackage: 'com.example.app',
      foregroundPackage: 'com.android.settings',
    },
  });
});

// A window the dump cannot name is no evidence that the session app kept the focus, so the guard
// still runs at its now-later position and its own read decides. An escape cannot turn into a pass
// by hiding in a read that named nothing.
test('press @ref still fails an escape when the after-command readiness read names no package', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-escape-unknown-focus';
  const session = makeAndroidSession(sessionName);
  session.appBundleId = 'com.example.app';
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Open Settings',
        rect: { x: 16, y: 40, width: 120, height: 48 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.publish(sessionName, session);

  mockTapPoint.mockResolvedValue({ pressed: true });
  mockGetAndroidBlockingDialogObservation.mockResolvedValue({ status: 'unknown' });
  mockGetAndroidAppState.mockResolvedValue({
    package: 'com.android.settings',
    activity: 'Settings',
  });

  await expect(
    handleInteractionCommands({
      createCommandSurface: touchCreateCommandSurface,
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
      ...getRuntimeBindings(),
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('foregrounded com.android.settings'),
  });
});

async function longPressAtPointWithFocusBefore(
  focusedPackageBefore: string,
  foregroundPackageAfter: string = LAUNCHER_PACKAGE,
) {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-longpress-focus-before';
  const session = makeAndroidSession(sessionName);
  session.appBundleId = 'com.example.app';
  sessionStore.publish(sessionName, session);
  // The before-command readiness read names the focused package; the after-command read is clear.
  mockGetAndroidBlockingDialogObservation.mockResolvedValueOnce({
    status: 'clear',
    focusedPackage: focusedPackageBefore,
  });
  mockGetAndroidAppState.mockResolvedValue({ package: foregroundPackageAfter, activity: 'Main' });
  return await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'longpress',
      positionals: ['540', '1300', '1000'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
}

test('longpress at a point fails, naming longpress, when the app owned the focus before and the launcher after', async () => {
  await expect(longPressAtPointWithFocusBefore('com.example.app')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringMatching(
      /^longpress .+ left com\.example\.app and foregrounded com\.google\.android\.apps\.nexuslauncher\./,
    ),
  });
  expect(mockLongPressPoint).toHaveBeenCalledTimes(1);
});

test('longpress at a point succeeds when the launcher owned the focus before and after the dispatch', async () => {
  const response = await longPressAtPointWithFocusBefore(LAUNCHER_PACKAGE);
  expect(response).toMatchObject({ ok: true });
  expect(mockLongPressPoint).toHaveBeenCalledTimes(1);
});

// Only an escape surface owning the focus skips the guard, not any package other than the app.
test.each([
  ['a permission prompt', 'com.google.android.permissioncontroller', 'com.android.settings'],
  ['a Trusted Web Activity', 'com.android.chrome', LAUNCHER_PACKAGE],
])(
  'longpress at a point keeps failing an escape when %s in the app flow owned the focus before',
  async (_flow, focusedPackageBefore, foregroundPackageAfter) => {
    await expect(
      longPressAtPointWithFocusBefore(focusedPackageBefore, foregroundPackageAfter),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      message: expect.stringContaining(
        `left com.example.app and foregrounded ${foregroundPackageAfter}.`,
      ),
    });
  },
);

test('longpress at a point warns about a second permission prompt that follows a first one', async () => {
  const response = await longPressAtPointWithFocusBefore(
    'com.google.android.permissioncontroller',
    'com.google.android.permissioncontroller',
  );
  expect(response).toMatchObject({
    ok: true,
    data: { warning: expect.stringMatching(/^longpress .+ opened an Android permission dialog/) },
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
    sessionStore.publish(sessionName, session);

    mockTapPoint.mockResolvedValue({ pressed: true });
    mockGetAndroidAppState.mockResolvedValue({
      package: packageName,
      activity: 'com.android.permissioncontroller.permission.ui.GrantPermissionsActivity',
    });

    const response = await handleInteractionCommands({
      createCommandSurface: touchCreateCommandSurface,
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
      ...getRuntimeBindings(),
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
  sessionStore.publish(sessionName, session);

  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: { token: 't', session: sessionName, command: 'press', positionals: ['@e1'], flags: {} },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
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
  expect(mockTapPoint).not.toHaveBeenCalled();
});
