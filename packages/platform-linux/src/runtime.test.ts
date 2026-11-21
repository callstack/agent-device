import { expect, test } from 'vitest';
import type { DeviceBinding } from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { HOVER_UNAVAILABLE_HINT } from '@agent-device/contracts/touch-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createLinuxHostStub, type LinuxHostStub } from './toolbox.fixtures.ts';
import { createLinuxToolProvider } from './tool-provider.ts';
import { createLinuxPlatformRuntime } from './runtime.ts';
import type { LinuxSnapshotSurface } from '@agent-device/contracts/linux-tool-provider';

type LegacyLifecycleCell = Readonly<{
  openTarget: boolean;
  prepareAppleRunner: boolean;
  closeTarget: boolean;
  runtimeHints: boolean;
  portReverse: boolean;
}>;

const LINUX_DEVICE = {
  platform: 'linux' as const,
  id: 'linux',
  name: 'Linux',
  kind: 'device' as const,
  target: 'desktop' as const,
  booted: true,
} satisfies DeviceInfo;

/** One AT-SPI capture the runtime was asked to make: the surface and the signal it was given. */
type CapturedAtspi = Readonly<{ surface: LinuxSnapshotSurface; signal: AbortSignal | undefined }>;

/** Every capture the runtime asked its provider to make, newest last. */
function createCaptureRecorder() {
  const captures: CapturedAtspi[] = [];
  return {
    captures,
    overrides: {
      accessibility: {
        captureTree: async (surface: LinuxSnapshotSurface, options?: { signal?: AbortSignal }) => {
          captures.push({ surface, signal: options?.signal });
          return { nodes: [], truncated: false, surface };
        },
      },
    },
  };
}

test.each([
  {
    name: 'desktop device',
    device: LINUX_DEVICE,
    // Legacy open/close descriptor cell: linux.device. Runtime and prepare had no dispatch cell.
    legacy: {
      openTarget: true,
      prepareAppleRunner: false,
      closeTarget: true,
      runtimeHints: false,
      portReverse: false,
    },
  },
  {
    name: 'synthetic emulator',
    device: {
      ...LINUX_DEVICE,
      id: 'linux-emulator',
      name: 'Linux emulator',
      kind: 'emulator' as const,
    },
    legacy: {
      openTarget: false,
      prepareAppleRunner: false,
      closeTarget: false,
      runtimeHints: false,
      portReverse: false,
    },
  },
  {
    name: 'synthetic simulator',
    device: {
      ...LINUX_DEVICE,
      id: 'linux-simulator',
      name: 'Linux simulator',
      kind: 'simulator' as const,
    },
    legacy: {
      openTarget: false,
      prepareAppleRunner: false,
      closeTarget: false,
      runtimeHints: false,
      portReverse: false,
    },
  },
] satisfies ReadonlyArray<
  Readonly<{ name: string; device: DeviceInfo; legacy: LegacyLifecycleCell }>
>)(
  'classifies the Linux $name lifecycle denominator against the legacy dispatch cell',
  async ({ device, legacy }) => {
    const binding = await createLinuxRuntime().bind({
      device,
      intent: { kind: 'ordinary' },
      scope: requestScope(),
    });
    expect(binding.facts.operations.networkDump).toMatchObject({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.facts.operations.ensureReady).toMatchObject({ available: false });
    expect(binding.facts.operations.bootTarget).toMatchObject({ available: false });
    expect(binding.facts.operations.bootTargetHeadless).toMatchObject({ available: false });
    expect(binding.facts.operations.appState).toMatchObject({ available: false });
    expect(binding.facts.operations.perfMemorySample).toMatchObject({ available: false });
    expect(binding.operations.perfMemorySample).toBeUndefined();
    expect(binding.facts.operations.listApps).toMatchObject({ available: false });
    expect(binding.facts.operations.captureSnapshot.available).toBe(device.kind === 'device');
    // The Linux read is value-first where the captured tree is label-first, so the desktop row
    // genuinely reads differently from its snapshot text and advertises the live read.
    expect(binding.facts.operations.readTextAtPoint.available).toBe(device.kind === 'device');
    expect(binding.facts.operations.captureSnapshotWithCustomActions.available).toBe(false);
    expect(binding.facts.operations.captureSnapshotWithoutActiveApp.available).toBe(
      device.kind === 'device',
    );
    expect(binding.facts.operations.setViewport).toMatchObject({ available: false });
    expect(binding.operations.setViewport).toBeUndefined();
    // R40/R41: the desktop is the only Linux cell with a pointer and keyboard to drive.
    expect(binding.facts.operations.focusPoint.available).toBe(device.kind === 'device');
    expect(binding.facts.operations.typeText.available).toBe(device.kind === 'device');
    expect(binding.operations.focusPoint).toBeTypeOf(
      device.kind === 'device' ? 'function' : 'undefined',
    );
    expect(binding.operations.typeText).toBeTypeOf(
      device.kind === 'device' ? 'function' : 'undefined',
    );
    expectLinuxNavigationAndKeyboardFacts(binding, device);
    // R60: audio probing never carried a Linux capability bucket, so every leaf refuses both
    // probe operations at admission.
    expect(binding.facts.operations.audioProbeStart).toMatchObject({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.facts.operations.audioProbeQuery).toMatchObject({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.operations.audioProbeStart).toBeUndefined();
    expect(binding.facts.operations.captureScreenshot.available).toBe(device.kind === 'device');
    expect(binding.operations.captureScreenshot).toBeTypeOf(
      device.kind === 'device' ? 'function' : 'undefined',
    );
    expect(binding.operations.captureSnapshot).toBeTypeOf(
      device.kind === 'device' ? 'function' : 'undefined',
    );
    expectLifecycleFacts(binding, legacy);
  },
);

test('the Linux runtime captures its own surface through the AT-SPI provider', async () => {
  const recorder = createCaptureRecorder();
  const runtime = createLinuxRuntime(recorder.overrides);
  const binding = await runtime.bind({
    device: LINUX_DEVICE,
    intent: { kind: 'ordinary' },
    scope: requestScope(),
  });

  const snapshot = await binding.operations.captureSnapshot?.({
    options: { interactiveOnly: true, depth: 2, scope: 'Settings', surface: 'desktop' },
  });

  expect(snapshot?.producer).toBe('linux-atspi');
  // The capture is the family's own: no desktop-surface loader is asked, and the request's projection
  // options are applied by the plugin.
  expect(recorder.captures).toEqual([{ surface: 'desktop', signal: expect.any(AbortSignal) }]);
  expect(runtime.stub.diagnostics).toEqual([]);
});

test('the Linux runtime asks for the frontmost app when the request names the app surface', async () => {
  const recorder = createCaptureRecorder();
  const binding = await createLinuxRuntime(recorder.overrides).bind({
    device: LINUX_DEVICE,
    intent: { kind: 'ordinary' },
    scope: requestScope(),
  });

  await binding.operations.captureSnapshot?.({ options: { surface: 'app' } });

  expect(recorder.captures.map((capture) => capture.surface)).toEqual(['frontmost-app']);
});

// `linuxSnapshotOperations` is the direct capture owner now, so the shared
// `bindSnapshotInteractor` composition does not cover it. Note it composes against
// `request.scope.signal` rather than `request.signal` — the Linux owner takes its signal off the
// request scope, which is exactly the detail a patch application can get wrong silently.
test('the Linux surface capture composes the per-capture signal with the request scope signal', async () => {
  const recorder = createCaptureRecorder();
  const scope = new AbortController();
  const binding = await createLinuxRuntime(recorder.overrides).bind({
    device: LINUX_DEVICE,
    intent: { kind: 'ordinary' },
    scope: { ...requestScope(), signal: scope.signal },
  });

  const poll = new AbortController();
  await binding.operations.captureSnapshot?.({ options: {}, signal: poll.signal });

  const passed = recorder.captures[0]!.signal!;
  expect(passed.aborted).toBe(false);
  poll.abort(new DOMException('Wait deadline exceeded', 'TimeoutError'));
  expect(passed.aborted).toBe(true);

  // The scope signal must still cancel too: composition adds a way to cancel, never replaces one.
  const second = new AbortController();
  await binding.operations.captureSnapshot?.({ options: {}, signal: second.signal });
  const passedSecond = recorder.captures[1]!.signal!;
  scope.abort();
  expect(passedSecond.aborted).toBe(true);
});

// R52/R53: Linux is the one owner whose gesture tiers genuinely split. Its drag primitive
// preserves a coordinate fling's endpoints but not a direction-authored fling's speed semantics
// (`gesture fling is not supported on Linux`), it synthesizes one contact, and it has no frame
// read of its own — which is why `gestureViewport` is PREFERRED rather than required.
test.each([
  ['desktop device', 'device' as const, true],
  ['non-desktop kind', 'emulator' as const, false],
])('declares the Linux %s gesture and scroll cells', async (_name, kind, supported) => {
  const facts = await createLinuxRuntime().inspectFacts({
    ...LINUX_DEVICE,
    kind,
  });
  expect(facts.operations.performGesturePlan.available).toBe(supported);
  expect(facts.operations.scrollDirection.available).toBe(supported);
  expect(facts.operations.performDirectionalFlingPlan.available).toBe(false);
  expect(facts.operations.performMultiTouchGesturePlan.available).toBe(false);
  expect(facts.operations.performTargetAuthoredDrag).toMatchObject({
    available: false,
    hint: expect.stringContaining('source hold, timed movement, and destination hold'),
  });
  expect(facts.operations.gestureViewport.available).toBe(false);
});

test('hover has no Linux interactor route; the touch family reports its typed denial', async () => {
  const facts = await createLinuxRuntime().inspectFacts(LINUX_DEVICE);
  const hoverDenial = {
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: HOVER_UNAVAILABLE_HINT,
  };
  expect(facts.operations.hoverPoint).toEqual(hoverDenial);
  expect(facts.operations.hoverRef).toEqual(hoverDenial);
});

test('binds the Linux coordinate-fling tier without a frame read', async () => {
  const binding = await createLinuxRuntime().bind({
    device: LINUX_DEVICE,
    intent: { kind: 'ordinary' },
    scope: requestScope(),
  });
  expect(binding.operations.performGesturePlan).toBeTypeOf('function');
  expect(binding.operations.scrollDirection).toBeTypeOf('function');
  expect(binding.operations.performDirectionalFlingPlan).toBeUndefined();
  expect(binding.operations.performMultiTouchGesturePlan).toBeUndefined();
  expect(binding.operations.performTargetAuthoredDrag).toBeUndefined();
  // Absent, not broken: the caller derives the coordinate frame from a capture instead, which is
  // exactly how a Linux gesture resolved its viewport before this migration.
  expect(binding.operations.gestureViewport).toBeUndefined();
});

test('refuses to bind a device of another family', async () => {
  await expect(
    createLinuxRuntime().bind({
      device: { ...LINUX_DEVICE, platform: 'android' as never },
      intent: { kind: 'ordinary' },
      scope: requestScope(),
    }),
  ).rejects.toThrow(/Linux runtime cannot bind this device/);
});

test('refuses an exact-owner intent for another owner', async () => {
  const runtime = createLinuxRuntime();
  await expect(
    runtime.bind({
      device: LINUX_DEVICE,
      intent: { kind: 'exact-owner', owner: { kind: 'local', family: 'macos' } } as never,
      scope: requestScope(),
    }),
  ).rejects.toThrow(/owner identity does not match/);
});

function createLinuxRuntime(
  providerOverrides: Parameters<typeof createLinuxToolProvider>[1] = {},
  stub: LinuxHostStub = createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    respond: () => ({}),
  }),
) {
  const host = {
    localInteractors: { resolve: async () => ({}) },
    clock: { sleep: async () => {} },
  } as unknown as PlatformRuntimeHost;
  const provider = createLinuxToolProvider(stub.toolbox, {
    sleep: async () => {},
    ...providerOverrides,
  });
  // The runtime owner, with the host stub attached for the tests that assert what it recorded.
  return Object.assign({}, createLinuxPlatformRuntime(host, stub.toolbox, provider), { stub });
}

function requestScope() {
  return {
    signal: new AbortController().signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
}

function expectLifecycleFacts(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  legacy: LegacyLifecycleCell,
): void {
  const operations = [
    ['openTarget', ['resolveOpenTarget', 'prepareApplicationOpen', 'openApplication']],
    ['prepareAppleRunner', ['prepareAppleRunner']],
    ['closeTarget', ['closeApplication', 'finalizeApplicationClose']],
    ['runtimeHints', ['applyRuntimeHints', 'clearRuntimeHints']],
    ['portReverse', ['configureProviderPortReverse']],
  ] as const;
  for (const [facet, names] of operations) {
    for (const name of names) {
      expect(binding.facts.operations[name].available).toBe(legacy[facet]);
      if (legacy[facet]) expect(binding.operations[name]).toBeTypeOf('function');
      else expect(binding.operations[name]).toBeUndefined();
    }
  }
}

/**
 * back/home/clipboard parity with the retired capability buckets: the desktop is the only Linux
 * cell with a target to drive. orientation/tv-remote/keyboard never carried a Linux bucket at all.
 */
function expectLinuxNavigationAndKeyboardFacts(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  device: DeviceInfo,
): void {
  const desktop = device.kind === 'device';
  expect(binding.facts.operations.back.available).toBe(desktop);
  expect(binding.facts.operations.home.available).toBe(desktop);
  expect(binding.operations.back).toBeTypeOf(desktop ? 'function' : 'undefined');
  expect(binding.operations.home).toBeTypeOf(desktop ? 'function' : 'undefined');
  // R55: `clipboard`'s retired bucket was `{ device: true }` too — wl-clipboard/xclip/xsel drive
  // the desktop session's selection, and no other Linux cell has one.
  expect(binding.facts.operations.readClipboard.available).toBe(desktop);
  expect(binding.facts.operations.writeClipboard.available).toBe(desktop);
  expect(binding.operations.readClipboard).toBeTypeOf(desktop ? 'function' : 'undefined');
  expect(binding.operations.writeClipboard).toBeTypeOf(desktop ? 'function' : 'undefined');
  for (const operation of [
    'setOrientation',
    'tvRemote',
    'keyboardStatus',
    'keyboardDismiss',
    'keyboardEnter',
    // R56: the Linux interactor's own `appSwitcher` throws, and the retired descriptor declared
    // `linux: {}`, so no Linux cell was ever admitted.
    'appSwitcher',
    // The Action Button is iPhone/iPad hardware; the Linux desktop has no equivalent control,
    // and neither does it have the phone volume and power keys hardware-button presses (#3848).
    'actionButton',
    'shake',
    'volumeUp',
    'volumeDown',
    'power',
    // Nor does it have a foldable hinge to pose.
    'setFoldPose',
    // Nor a modem to simulate a call or text message on.
    'sendTelephonyEvent',
    // R57: the retired `trigger-app-event` descriptor declared `linux: {}` too.
    'triggerAppEvent',
    // R58/R59: and so did `settings` and `alert`.
    'setSetting',
    'readAlert',
    'awaitAlert',
    'acceptAlert',
    'dismissAlert',
  ] as const) {
    expect(binding.facts.operations[operation]).toEqual({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.operations[operation]).toBeUndefined();
  }
}
