import { expect, test, vi } from 'vitest';
import type {
  DeviceBinding,
  PlatformRuntimeOperations,
  RuntimeFacts,
  SnapshotRuntimeHost,
} from '@agent-device/contracts/platform';
import type { AppleOS, DeviceInfo } from '@agent-device/kernel/device';
import { createApplePlatformRuntime } from './runtime.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';

function appleDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: 'apple-fact',
    name: 'Apple',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
    ...overrides,
  };
}

const leaves = {
  ios: appleDevice(),
  ipados: appleDevice({ appleOs: 'ipados' }),
  tvos: appleDevice({ appleOs: 'tvos', target: 'tv' }),
  macos: appleDevice({ appleOs: 'macos', kind: 'device', target: 'desktop' }),
  visionos: appleDevice({ appleOs: 'visionos' }),
  watchos: appleDevice({ appleOs: 'watchos' }),
} satisfies Record<AppleOS, DeviceInfo>;

test.each([
  ['iOS simulator', leaves.ios, true, undefined],
  [
    'iOS physical CoreDevice',
    appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
    true,
    undefined,
  ],
  [
    'iOS physical XCTest',
    appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'xctest' }),
    false,
    'CoreDevice-backed physical iOS device',
  ],
  ['iPadOS simulator', leaves.ipados, true, undefined],
  ['tvOS simulator', leaves.tvos, true, undefined],
  ['macOS host', leaves.macos, true, undefined],
  ['visionOS simulator', leaves.visionos, true, undefined],
  ['watchOS sentinel', leaves.watchos, false, 'watchOS app logs are not supported'],
])('classifies the %s leaf explicitly', async (_name, device, available, hint) => {
  const binding = await createApplePlatformRuntime(platformRuntimeHostFixture()).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  const { facts } = binding;
  expect(facts.device.providerMode).toBe('local');
  expect(facts.operations.appState).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: expect.stringContaining('session state'),
  });
  expect(binding.operations.appState).toBeUndefined();
  expect(facts.operations.networkDump).toEqual({ available: true });
  expect(facts.operations.listApps.available).toBe(
    device.appleOs !== 'watchos' && device.iosPhysicalDeviceBackend !== 'xctest',
  );
  // R40/R41: touch and text ride the Apple interactor, which exists for the simulator and
  // physical device kinds — every leaf in this table is one of those two, so both cells are
  // available across it (parity with the retired buckets).
  expect(facts.operations.focusPoint).toEqual({ available: true });
  expect(facts.operations.typeText).toEqual({ available: true });
  expect(binding.operations.focusPoint).toBeTypeOf('function');
  expect(binding.operations.typeText).toBeTypeOf('function');
  for (const operation of ['appLogInspect', 'appLogDoctor', 'appLogStart'] as const) {
    const fact = facts.operations[operation];
    expect(fact.available).toBe(available);
    if (!available && hint) expect(fact).toHaveProperty('hint', expect.stringContaining(hint));
  }
  for (const operation of [
    'screenRecordingStart',
    'screenRecordingReattach',
    'screenRecordingCleanup',
  ] as const) {
    expect(facts.operations[operation].available).toBe(available);
  }
  if (device.iosPhysicalDeviceBackend === 'xctest') {
    expect(facts.operations.screenRecordingStart).toMatchObject({
      hint: expect.stringContaining('CoreDevice-backed physical iOS device'),
    });
  }
  if (device.appleOs === 'watchos') {
    expect(facts.operations.screenRecordingStart).toMatchObject({
      hint: 'watchOS recording is not supported.',
    });
  }
  expect(facts.operations.ensureReady.available).toBe(device.appleOs !== 'watchos');
  expect(facts.operations.bootTarget.available).toBe(
    device.appleOs !== 'macos' && device.appleOs !== 'watchos',
  );
  expect(facts.operations.bootTargetHeadless.available).toBe(false);
  expect(facts.operations.setViewport).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: 'viewport resizes web targets only (--platform web). Apple screen geometry is fixed by the selected simulator or device type — open a different simulator to test another screen size.',
  });
  expect(binding.operations.setViewport).toBeUndefined();
  expectAppleCaptureAvailability(binding, device);
  expectAppleSnapshotAvailability(binding, device);
});

/**
 * watchOS is admitted by no capture cell: the Apple interactor cannot even be constructed for it,
 * so the refusal is a fact rather than a throw from inside the leaf.
 */
function expectAppleCaptureAvailability(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  device: DeviceInfo,
): void {
  const available = device.appleOs !== 'watchos';
  expect(binding.facts.operations.captureScreenshot.available).toBe(available);
  expect(binding.operations.captureScreenshot).toBeTypeOf(available ? 'function' : 'undefined');
}

function expectAppleSnapshotAvailability(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  device: DeviceInfo,
): void {
  const available = device.appleOs !== 'watchos';
  expect(binding.facts.operations.captureSnapshot.available).toBe(available);
  expect(binding.facts.operations.captureSnapshotWithCustomActions.available).toBe(
    device.appleOs !== 'macos' && device.appleOs !== 'watchos' && device.kind === 'simulator',
  );
  expect(binding.facts.operations.captureSnapshotWithoutActiveApp.available).toBe(
    device.appleOs === 'macos',
  );
  expect(binding.operations.captureSnapshot).toBeTypeOf(available ? 'function' : 'undefined');
  // The live point read needs a driveable Apple UI, so it follows the same watchOS sentinel the
  // capture does; every other supported leaf advertises and binds it.
  expect(binding.facts.operations.readTextAtPoint.available).toBe(available);
  expect(binding.operations.readTextAtPoint).toBeTypeOf(available ? 'function' : 'undefined');
  const nativeSelectorAvailable = available && device.appleOs !== 'macos';
  expect(binding.facts.operations.findSelector.available).toBe(nativeSelectorAvailable);
  expect(binding.operations.findSelector).toBeTypeOf(
    nativeSelectorAvailable ? 'function' : 'undefined',
  );
}

test.each(Object.entries(leaves))(
  'classifies back/home/orientation/tv-remote/keyboard facts for the %s leaf',
  async (_name, device) => {
    const binding = await createApplePlatformRuntime(platformRuntimeHostFixture()).bind({
      device,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });
    expectNavigationAndKeyboardFacts(binding, device);
  },
);

/** Both the fact and the bound operation function agree on availability, for one operation. */
function expectOperationAvailability(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  operation: keyof PlatformRuntimeOperations,
  available: boolean,
): void {
  expect(binding.facts.operations[operation].available).toBe(available);
  expect(binding.operations[operation]).toBeTypeOf(available ? 'function' : 'undefined');
}

/**
 * watchOS has no constructible Apple interactor (XCUITest cannot drive its UI, ADR-0009), so every
 * interactor-backed operation here stays unavailable there regardless of what else gates it.
 */
function expectNavigationAndKeyboardFacts(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  device: DeviceInfo,
): void {
  // Every simulator/device leaf supports back except watchOS, tvOS's Menu remote press
  // included — no apple-family closure ever gated it beyond device kind and interactor
  // constructibility.
  expectOperationAvailability(binding, 'back', device.appleOs !== 'watchos');

  // home is unavailable on macOS, which drives an already-running app with no springboard, and
  // on watchOS.
  expectOperationAvailability(
    binding,
    'home',
    device.appleOs !== 'macos' && device.appleOs !== 'watchos',
  );

  // orientation and keyboard dismiss/enter share mobile-input eligibility: unavailable on tvOS
  // (focus-only XCUIRemote navigation), macOS (an AppKit desktop host), and watchOS.
  const mobileInputEligible =
    device.appleOs !== 'tvos' && device.appleOs !== 'macos' && device.appleOs !== 'watchos';
  expectOperationAvailability(binding, 'setOrientation', mobileInputEligible);
  expectOperationAvailability(binding, 'keyboardDismiss', mobileInputEligible);
  expectOperationAvailability(binding, 'keyboardEnter', mobileInputEligible);

  expectKeyboardStatusFact(binding, mobileInputEligible);
  expectTvRemoteFact(binding, device);
}

/** Apple never had a live keyboard status read: every eligible leaf still refuses status/get with
 * the retired in-handler hint; ineligible leaves fall through the outer cell instead. */
function expectKeyboardStatusFact(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  mobileInputEligible: boolean,
): void {
  expect(binding.facts.operations.keyboardStatus.available).toBe(false);
  if (mobileInputEligible) {
    expect(binding.facts.operations.keyboardStatus).toHaveProperty(
      'hint',
      expect.stringContaining('keyboard status/get is currently supported only on Android'),
    );
  }
  expect(binding.operations.keyboardStatus).toBeUndefined();
}

/** tv-remote is available only for tvOS, which drives navigation through XCUIRemote presses. */
function expectTvRemoteFact(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  device: DeviceInfo,
): void {
  const tvRemoteAvailable = device.appleOs === 'tvos';
  expectOperationAvailability(binding, 'tvRemote', tvRemoteAvailable);
  if (!tvRemoteAvailable) {
    expect(binding.facts.operations.tvRemote).toHaveProperty(
      'hint',
      'tv-remote is supported only on tvOS devices.',
    );
  }
}

test.each(['frontmost-app', 'desktop', 'menubar'] as const)(
  'routes the macOS %s surface through the exact Apple surface host',
  async (surface) => {
    const host = platformRuntimeHostFixture();
    const captureSurface = vi.fn(async () => ({
      backend: 'macos-helper' as const,
      producer: 'macos-helper' as const,
      nodes: [],
      truncated: false,
    }));
    const resolve = vi.fn(async () => ({}) as never);
    const binding = await createApplePlatformRuntime({
      ...host,
      localInteractors: { resolve },
      snapshot: { captureSurface },
    }).bind({
      device: leaves.macos,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });

    await expect(
      binding.operations.captureSnapshot?.({
        options: { surface, appBundleId: 'com.example.app', depth: 3 },
      }),
    ).resolves.toMatchObject({ backend: 'macos-helper' });
    expect(captureSurface).toHaveBeenCalledWith(
      leaves.macos,
      { surface, appBundleId: 'com.example.app', depth: 3 },
      expect.any(AbortSignal),
    );
    expect(resolve).not.toHaveBeenCalled();
  },
);

test('readiness and boot keep the Apple automation helper warm inside the platform runtime', async () => {
  const host = platformRuntimeHostFixture();
  const keepHot = vi.fn();
  let state = 'Shutdown';
  const runtime = createApplePlatformRuntime({
    ...host,
    appleTools: {
      ...host.appleTools,
      run: vi.fn(async (request) => {
        if (request.args.includes('list')) {
          return {
            stdout: JSON.stringify({ devices: { ios: [{ udid: 'apple-fact', state }] } }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (request.args.includes('boot')) state = 'Booted';
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    },
    deviceReadiness: {
      ...host.deviceReadiness,
      appleAutomation: {
        keepHot,
        markBooted: vi.fn(),
        wasRecentlyObservedBooted: vi.fn(async () => false),
      },
    },
  });
  const device = appleDevice({ booted: false });
  const binding = await runtime.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  await binding.operations.ensureReady?.({});
  await binding.operations.bootTarget?.({});

  expect(keepHot).toHaveBeenCalledTimes(3);
  expect(keepHot).toHaveBeenNthCalledWith(1, device);
  expect(keepHot).toHaveBeenNthCalledWith(2, device);
  expect(keepHot).toHaveBeenNthCalledWith(3, device);
});

test('macOS readiness is a no-op while boot remains unavailable', async () => {
  const host = platformRuntimeHostFixture();
  const ensureConnected = vi.fn(host.deviceReadiness.applePhysical.ensureConnected);
  const binding = await createApplePlatformRuntime({
    ...host,
    deviceReadiness: {
      ...host.deviceReadiness,
      applePhysical: { ensureConnected },
    },
  }).bind({
    device: leaves.macos,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  await expect(binding.operations.ensureReady?.({})).resolves.toMatchObject({ booted: true });
  expect(ensureConnected).not.toHaveBeenCalled();
  expect(binding.operations.bootTarget).toBeUndefined();
});

test('routes Apple app inventory through the injected host facet', async () => {
  const host = platformRuntimeHostFixture();
  const listApps = vi.fn(async () => [{ id: 'com.example.app', name: 'Example' }]);
  const runtime = createApplePlatformRuntime({
    ...host,
    appInventory: {
      ...host.appInventory,
      apple: { listApps },
    },
  });
  const device = appleDevice();
  const binding = await runtime.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  await expect(binding.operations.listApps?.({ device, filter: 'all' })).resolves.toEqual([
    { id: 'com.example.app', name: 'Example' },
  ]);
  expect(listApps).toHaveBeenCalledWith(device, 'all', expect.any(AbortSignal));
});

type LegacyLifecycleCell = Readonly<{
  openTarget: boolean;
  prepareAppleRunner: boolean;
  closeTarget: boolean;
  runtimeHints: boolean;
  portReverse: boolean;
}>;

const LEGACY_IOS_SIMULATOR: LegacyLifecycleCell = {
  openTarget: true,
  prepareAppleRunner: true,
  closeTarget: true,
  runtimeHints: true,
  portReverse: false,
};
const LEGACY_APPLE_DEVICE: LegacyLifecycleCell = {
  openTarget: true,
  prepareAppleRunner: true,
  closeTarget: true,
  runtimeHints: false,
  portReverse: false,
};
const LEGACY_UNSUPPORTED: LegacyLifecycleCell = {
  openTarget: false,
  prepareAppleRunner: false,
  closeTarget: false,
  runtimeHints: false,
  portReverse: false,
};

// The legacy descriptor/dispatch oracle is leaf- and kind-specific. Keep the full current
// denominator here instead of deriving it from Apple family ownership or a sibling operation.
const LEGACY_APPLE_LIFECYCLE_CELLS = {
  ios: {
    simulator: LEGACY_IOS_SIMULATOR,
    emulator: LEGACY_UNSUPPORTED,
    device: LEGACY_APPLE_DEVICE,
  },
  ipados: {
    simulator: LEGACY_IOS_SIMULATOR,
    emulator: LEGACY_UNSUPPORTED,
    device: LEGACY_APPLE_DEVICE,
  },
  tvos: {
    simulator: LEGACY_IOS_SIMULATOR,
    emulator: LEGACY_UNSUPPORTED,
    device: LEGACY_APPLE_DEVICE,
  },
  macos: {
    simulator: LEGACY_APPLE_DEVICE,
    emulator: LEGACY_UNSUPPORTED,
    device: LEGACY_APPLE_DEVICE,
  },
  visionos: {
    simulator: LEGACY_IOS_SIMULATOR,
    emulator: LEGACY_UNSUPPORTED,
    device: LEGACY_APPLE_DEVICE,
  },
  watchos: {
    simulator: LEGACY_UNSUPPORTED,
    emulator: LEGACY_UNSUPPORTED,
    device: LEGACY_UNSUPPORTED,
  },
} satisfies Record<AppleOS, Record<DeviceInfo['kind'], LegacyLifecycleCell>>;

const APPLE_LEAF_TARGETS = {
  ios: 'mobile',
  ipados: 'mobile',
  tvos: 'tv',
  macos: 'desktop',
  visionos: 'mobile',
  watchos: 'mobile',
} satisfies Record<AppleOS, NonNullable<DeviceInfo['target']>>;

const appleLifecycleDenominator = (
  Object.entries(LEGACY_APPLE_LIFECYCLE_CELLS) as Array<
    [AppleOS, Record<DeviceInfo['kind'], LegacyLifecycleCell>]
  >
).flatMap(([appleOs, cells]) =>
  (Object.entries(cells) as Array<[DeviceInfo['kind'], LegacyLifecycleCell]>).map(
    ([kind, legacy]) => ({
      name: `${appleOs} ${kind}`,
      device: appleDevice({
        appleOs,
        id: `apple-${appleOs}-${kind}`,
        kind,
        target: APPLE_LEAF_TARGETS[appleOs],
      }),
      legacy,
    }),
  ),
);

function expectLegacyLifecycleCell(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  legacy: LegacyLifecycleCell,
): void {
  expectLegacyLifecycleFactCell(binding.facts, legacy);
  const operations = [
    ['openTarget', ['resolveOpenTarget', 'prepareApplicationOpen', 'openApplication']],
    ['prepareAppleRunner', ['prepareAppleRunner']],
    ['closeTarget', ['closeApplication', 'finalizeApplicationClose']],
    ['runtimeHints', ['applyRuntimeHints', 'clearRuntimeHints']],
    ['portReverse', ['configureProviderPortReverse']],
  ] as const;
  for (const [facet, names] of operations) {
    for (const name of names) {
      if (legacy[facet]) {
        expect(binding.operations[name]).toBeTypeOf('function');
      } else {
        expect(binding.operations[name]).toBeUndefined();
      }
    }
  }
}

test.each(appleLifecycleDenominator)(
  'publishes independent lifecycle facts for every Apple $name descriptor/dispatch cell',
  async ({ device, legacy }) => {
    const runtime = createApplePlatformRuntime(platformRuntimeHostFixture());
    expectLegacyLifecycleFactCell(await runtime.inspectFacts(device), legacy);
    expectLegacyLifecycleCell(
      await runtime.bind({
        device,
        intent: { kind: 'ordinary' },
        scope: {
          signal: new AbortController().signal,
          diagnostics: { emit: () => {} },
          progress: { report: () => {} },
        },
      }),
      legacy,
    );
  },
);

function expectLegacyLifecycleFactCell(
  facts: RuntimeFacts<PlatformRuntimeOperations>,
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
      expect(facts.operations[name].available).toBe(legacy[facet]);
    }
  }
  const snapshotAvailable =
    facts.device.appleOs !== 'watchos' &&
    (facts.device.kind === 'simulator' || facts.device.kind === 'device');
  expect(facts.operations.captureSnapshot.available).toBe(snapshotAvailable);
  expect(facts.operations.readTextAtPoint.available).toBe(snapshotAvailable);
  expect(facts.operations.findSelector.available).toBe(
    snapshotAvailable && facts.device.appleOs !== 'macos',
  );
}

// The macOS non-app surface branch calls `captureSurface` directly instead of going through
// `bindSnapshotInteractor`, so the shared composition does NOT cover it. If this branch drops the
// per-capture signal, desktop-surface captures silently ignore a wait's poll deadline while every
// other family honours it.
test('the macOS surface branch composes the per-capture signal with the binding signal', async () => {
  const host = platformRuntimeHostFixture();
  const captureSurface = vi.fn<SnapshotRuntimeHost['captureSurface']>(async () => ({
    backend: 'macos-helper' as const,
    producer: 'macos-helper' as const,
    nodes: [],
    truncated: false,
  }));
  const binding = await createApplePlatformRuntime({
    ...host,
    localInteractors: { resolve: vi.fn(async () => ({}) as never) },
    snapshot: { captureSurface },
  }).bind({
    device: leaves.macos,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  const poll = new AbortController();
  await binding.operations.captureSnapshot?.({
    options: { surface: 'desktop', appBundleId: 'com.example.app' },
    signal: poll.signal,
  });

  const passed = captureSurface.mock.calls[0]?.[2] as AbortSignal;
  expect(passed.aborted).toBe(false);
  poll.abort(new DOMException('Wait deadline exceeded', 'TimeoutError'));
  expect(passed.aborted).toBe(true);
});
