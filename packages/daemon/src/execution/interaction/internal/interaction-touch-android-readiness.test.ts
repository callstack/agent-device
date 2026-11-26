import { test, expect, vi, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
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
type EnsureAndroidBlockingSystemDialogReadyForTap =
  typeof import('../../android-system-dialog.ts').ensureAndroidBlockingSystemDialogReadyForTap;

const { androidDialogReadiness } = vi.hoisted(() => ({
  androidDialogReadiness: {
    spy: vi.fn<EnsureAndroidBlockingSystemDialogReady>(),
    actual: undefined as unknown as EnsureAndroidBlockingSystemDialogReady,
    tapSpy: vi.fn<EnsureAndroidBlockingSystemDialogReadyForTap>(),
    tapActual: undefined as unknown as EnsureAndroidBlockingSystemDialogReadyForTap,
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
// The guard polls the dialog focus between reads; these tests do not wait real time for it.
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

vi.mock('../../android-system-dialog.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../android-system-dialog.ts')>();
  androidDialogReadiness.actual = actual.ensureAndroidBlockingSystemDialogReady;
  androidDialogReadiness.tapActual = actual.ensureAndroidBlockingSystemDialogReadyForTap;
  return {
    ...actual,
    ensureAndroidBlockingSystemDialogReady: androidDialogReadiness.spy,
    ensureAndroidBlockingSystemDialogReadyForTap: androidDialogReadiness.tapSpy,
  };
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
  androidDialogReadiness.tapSpy.mockReset();
  androidDialogReadiness.tapSpy.mockImplementation((params) =>
    androidDialogReadiness.tapActual(params),
  );
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
  // A single press reads readiness through the tap variant.
  androidDialogReadiness.tapSpy.mockImplementation(async (params) => {
    expireRefFrame(params.session);
    return { status: 'recovered', warning: 'Recovered from a blocking system dialog' };
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

// While System UI's ANR dialog has focus, the guard refuses every input. The dialog's own
// buttons are the one input that can close it, so a single press on one of them goes through, and
// any other tap is still refused before it is sent.
const SYSTEM_UI_ANR = {
  status: 'dialog',
  focus: {
    package: 'com.android.systemui',
    focusedWindow: 'Application Not Responding: com.android.systemui',
    raw: 'mCurrentFocus=Window{ffeedd u0 Application Not Responding: com.android.systemui}',
  },
} as const;

function systemUiAnrScreen() {
  return attachRefs([
    {
      index: 0,
      type: 'android.widget.TextView',
      label: "System UI isn't responding",
      identifier: 'android:id/alertTitle',
      rect: { x: 50, y: 400, width: 500, height: 80 },
    },
    {
      index: 1,
      type: 'android.widget.Button',
      label: 'Close app',
      identifier: 'android:id/aerr_close',
      rect: { x: 100, y: 600, width: 220, height: 80 },
      enabled: true,
      hittable: true,
    },
    {
      index: 2,
      type: 'android.widget.Button',
      label: 'Wait',
      identifier: 'android:id/aerr_wait',
      rect: { x: 100, y: 700, width: 220, height: 80 },
      enabled: true,
      hittable: true,
    },
  ]);
}

type BlockingDialogObservation = Awaited<ReturnType<typeof getAndroidBlockingDialogObservation>>;

async function pressWithSystemUiAnr(
  positionals: string[],
  flags: Record<string, unknown> = {},
  setup: {
    /**
     * The focus read number `read` (from 0) returns, before and after the tap. By default the
     * dialog holds the focus until a tap reaches the device.
     */
    beforeTap?: (read: number) => BlockingDialogObservation;
    afterTap?: (read: number) => BlockingDialogObservation;
    command?: 'press' | 'click';
    /** The session's stored snapshot, when it was taken before the dialog appeared. */
    sessionNodes?: ReturnType<typeof attachRefs>;
  } = {},
) {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-system-ui-anr';
  const session = makeAndroidSession(sessionName);
  session.appBundleId = 'com.example.app';
  const nodes = systemUiAnrScreen();
  session.snapshot = {
    nodes: setup.sessionNodes ?? nodes,
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.publish(sessionName, session);

  const beforeTap = setup.beforeTap ?? (() => SYSTEM_UI_ANR);
  const afterTap = setup.afterTap ?? (() => ({ status: 'clear' }) as const);
  let tapped = false;
  let reads = 0;
  mockTapPoint.mockImplementation(async (input) => {
    tapped = true;
    reads = 0;
    return { x: input.point.x, y: input.point.y };
  });
  mockGetAndroidBlockingDialogObservation.mockImplementation(async () => {
    const read = reads;
    reads += 1;
    return tapped ? afterTap(read) : beforeTap(read);
  });
  const bindings = getRuntimeBindings();
  return await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: setup.command ?? 'press',
      positionals,
      flags,
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...bindings,
    androidObservation: { ...bindings.androidObservation, readSnapshotNodes: async () => nodes },
  });
}

test("press on the System UI ANR dialog's Close app goes through the blocking-dialog guard", async () => {
  const response = await pressWithSystemUiAnr(['@e2']);

  expect(response).toMatchObject({ ok: true });
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
  expect(mockTapPoint.mock.calls[0]?.[0].point).toEqual({ x: 210, y: 640 });
});

test("click on the System UI ANR dialog's Wait goes through the blocking-dialog guard", async () => {
  const response = await pressWithSystemUiAnr(['@e3'], {}, { command: 'click' });

  expect(response).toMatchObject({ ok: true });
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
  expect(mockTapPoint.mock.calls[0]?.[0].point).toEqual({ x: 210, y: 740 });
});

test('a press at a point outside the System UI ANR dialog buttons is refused before it is sent', async () => {
  const response = await pressWithSystemUiAnr(['540', '1500']);

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: expect.stringContaining('Android system dialog is blocking press'),
      details: { dispatched: 'no', focusedPackage: 'com.android.systemui' },
    },
  });
  expect(mockTapPoint).not.toHaveBeenCalled();
});

test.each([
  ['the right edge', ['320', '640']],
  ['the bottom edge', ['210', '680']],
])(
  "a press on %s of a System UI ANR dialog button is refused: Android's hit test excludes it",
  async (_edge, positionals) => {
    const response = await pressWithSystemUiAnr(positionals);

    expect(response).toMatchObject({ ok: false, error: { details: { dispatched: 'no' } } });
    expect(mockTapPoint).not.toHaveBeenCalled();
  },
);

test.each([
  ['a repeated press', ['@e2'], { count: 2 }],
  ['a double tap', ['@e2'], { doubleTap: true }],
  ['a multi-ref plan', ['@e2,@e3'], {}],
  ['a hold', ['@e2'], { holdMs: 800 }],
  ['a jittered press', ['@e2'], { jitterPx: 40 }],
  ['a selector', ['id="android:id/aerr_close"'], {}],
])('%s on the System UI ANR dialog stays refused', async (_shape, positionals, flags) => {
  // Later taps would land on whatever the closed dialog uncovers, a hold is not a tap, jitter can
  // move the contact off the button, and only a ref or a point is checked against the dialog.
  const response = await pressWithSystemUiAnr(positionals, flags);

  expect(response).toMatchObject({
    ok: false,
    error: { details: { dispatched: 'no' } },
  });
  expect(mockTapPoint).not.toHaveBeenCalled();
});

test('a ref from a snapshot taken before the ANR dialog is not retargeted to the dialog button over it', async () => {
  // The app's own button sits where the dialog's Close app now is: the tap would close System UI
  // and report it as a press of the app's button.
  const appScreen = attachRefs([
    {
      index: 0,
      type: 'android.widget.Button',
      label: 'Submit order',
      identifier: 'com.example.app:id/submit',
      rect: { x: 60, y: 590, width: 300, height: 100 },
      enabled: true,
      hittable: true,
    },
  ]);
  const response = await pressWithSystemUiAnr(['@e1'], {}, { sessionNodes: appScreen });

  expect(response).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining('Android system dialog is blocking press'),
      details: { dispatched: 'no' },
    },
  });
  expect(mockTapPoint).not.toHaveBeenCalled();
});

test('a Wait ref is not retargeted to Close app when the dialog buttons moved since the snapshot', async () => {
  // The stored snapshot shows Wait where the current dialog shows Close app.
  const [title, closeApp, wait] = systemUiAnrScreen();
  const storedScreen = attachRefs([
    { ...title! },
    { ...wait!, rect: closeApp!.rect! },
    { ...closeApp!, rect: wait!.rect! },
  ]);
  const response = await pressWithSystemUiAnr(['@e2'], {}, { sessionNodes: storedScreen });

  expect(response).toMatchObject({ ok: false, error: { details: { dispatched: 'no' } } });
  expect(mockTapPoint).not.toHaveBeenCalled();
});

test('a press on a System UI ANR dialog button is refused when the dialog loses focus before the send', async () => {
  // Readiness reads the dialog; by the read just before the send, Android has removed it, so the
  // button points now belong to the screen underneath.
  const response = await pressWithSystemUiAnr(
    ['@e2'],
    {},
    {
      beforeTap: (read) => (read === 0 ? SYSTEM_UI_ANR : { status: 'clear' }),
    },
  );

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: expect.stringContaining('Android system dialog lost focus before press was sent'),
      details: { dispatched: 'no' },
    },
  });
  expect(mockTapPoint).not.toHaveBeenCalled();
});

test.each([
  [
    'the focus read answers nothing',
    { status: 'unknown' } as const,
    'Android focus could not be read to confirm',
  ],
  [
    'another dialog has the focus',
    {
      status: 'dialog',
      focus: {
        package: 'com.example.other',
        focusedWindow: 'Application Not Responding: com.example.other',
        raw: 'mCurrentFocus=Window{aabbcc u0 Application Not Responding: com.example.other}',
      },
    } as const,
    'Android system dialog is blocking press',
  ],
])(
  'a press on a System UI ANR dialog button is refused when, before the send, %s',
  async (_case, beforeSend, message) => {
    const response = await pressWithSystemUiAnr(
      ['@e2'],
      {},
      {
        beforeTap: (read) => (read === 0 ? SYSTEM_UI_ANR : beforeSend),
      },
    );

    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(message), details: { dispatched: 'no' } },
    });
    expect(mockTapPoint).not.toHaveBeenCalled();
  },
);

test('a press on a System UI ANR dialog button is refused with nothing sent when the focus read fails', async () => {
  let reads = 0;
  const response = await pressWithSystemUiAnr(
    ['@e2'],
    {},
    {
      beforeTap: () => {
        reads += 1;
        if (reads > 1) throw new AppError('COMMAND_FAILED', 'adb: device offline');
        return SYSTEM_UI_ANR;
      },
    },
  );

  expect(response).toMatchObject({
    ok: false,
    error: { message: 'adb: device offline', details: { dispatched: 'no' } },
  });
  expect(mockTapPoint).not.toHaveBeenCalled();
});

test('a press on a System UI ANR dialog button waits for the dialog focus to clear', async () => {
  // Android removes the dialog window asynchronously: the first reads after the tap still show it.
  const response = await pressWithSystemUiAnr(
    ['@e2'],
    {},
    {
      afterTap: (read) => (read < 2 ? SYSTEM_UI_ANR : { status: 'clear' }),
    },
  );

  expect(response).toMatchObject({ ok: true });
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
});
