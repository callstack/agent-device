import type { DeviceBinding, RuntimeFacts } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import {
  limrunIosSimulator as device,
  limrunOwnerOptions,
  limrunScope as scope,
  unusedLimrunHost as unusedHost,
} from './app-log-runtime.fixtures.ts';
import { createLimrunPlatformRuntimeOwner } from './app-log-runtime.ts';

type LegacyLifecycleCell = Readonly<{
  openTarget: boolean;
  prepareAppleRunner: boolean;
  closeTarget: boolean;
  runtimeHints: boolean;
  portReverse: boolean;
}>;

const LIMRUN_SUPPORTED_IOS_LIFECYCLE_CELL: LegacyLifecycleCell = {
  openTarget: true,
  prepareAppleRunner: false,
  closeTarget: true,
  runtimeHints: false,
  portReverse: false,
};
const LIMRUN_SUPPORTED_ANDROID_LIFECYCLE_CELL: LegacyLifecycleCell = {
  openTarget: true,
  prepareAppleRunner: false,
  closeTarget: true,
  runtimeHints: false,
  portReverse: true,
};
const LIMRUN_UNSUPPORTED_LIFECYCLE_CELL: LegacyLifecycleCell = {
  openTarget: false,
  prepareAppleRunner: false,
  closeTarget: false,
  runtimeHints: false,
  portReverse: false,
};
const DEVICE_KINDS = ['simulator', 'emulator', 'device'] as const;
const APPLE_PROVIDER_LEAVES = [
  { appleOs: 'ios', target: 'mobile' },
  { appleOs: 'ipados', target: 'mobile' },
  { appleOs: 'tvos', target: 'tv' },
  { appleOs: 'macos', target: 'desktop' },
  { appleOs: 'visionos', target: 'mobile' },
  { appleOs: 'watchos', target: 'mobile' },
] as const;
const OTHER_PROVIDER_FAMILIES = [
  { platform: 'harmonyos', target: 'mobile' },
  { platform: 'vega', target: 'tv' },
  { platform: 'linux', target: 'desktop' },
  { platform: 'web', target: 'desktop' },
] as const;

// The direct Limrun provider only has two lifecycle dispatch cells: iOS-simulator/mobile and
// Android-emulator/mobile. Every other canonical leaf/kind/provider shape is fact-only and fails
// closed before a concrete provider binding is constructed.
const LIMRUN_LIFECYCLE_DENOMINATOR = [
  ...DEVICE_KINDS.map((kind) => ({
    name: `Android ${kind} mobile`,
    device: {
      platform: 'android' as const,
      id: `limrun:android:${kind}`,
      name: `Limrun Android ${kind}`,
      kind,
      target: 'mobile' as const,
      booted: true,
    },
    legacy:
      kind === 'emulator'
        ? LIMRUN_SUPPORTED_ANDROID_LIFECYCLE_CELL
        : LIMRUN_UNSUPPORTED_LIFECYCLE_CELL,
  })),
  ...APPLE_PROVIDER_LEAVES.flatMap(({ appleOs, target }) =>
    DEVICE_KINDS.map((kind) => ({
      name: `${appleOs} ${kind} ${target}`,
      device: {
        platform: 'apple' as const,
        appleOs,
        id: `limrun:ios:${appleOs}:${kind}`,
        name: `Limrun ${appleOs} ${kind}`,
        kind,
        target,
        booted: true,
      },
      legacy:
        appleOs === 'ios' && kind === 'simulator' && target === 'mobile'
          ? LIMRUN_SUPPORTED_IOS_LIFECYCLE_CELL
          : LIMRUN_UNSUPPORTED_LIFECYCLE_CELL,
    })),
  ),
  ...OTHER_PROVIDER_FAMILIES.flatMap(({ platform, target }) =>
    DEVICE_KINDS.map((kind) => ({
      name: `${platform} ${kind} ${target}`,
      device: {
        platform,
        id: `limrun:android:${platform}:${kind}`,
        name: `Limrun ${platform} ${kind}`,
        kind,
        target,
        booted: true,
      },
      legacy: LIMRUN_UNSUPPORTED_LIFECYCLE_CELL,
    })),
  ),
  {
    name: 'Android emulator TV target',
    device: {
      platform: 'android' as const,
      id: 'limrun:android:tv',
      name: 'Limrun Android TV',
      kind: 'emulator' as const,
      target: 'tv' as const,
      booted: true,
    },
    legacy: LIMRUN_UNSUPPORTED_LIFECYCLE_CELL,
  },
  {
    name: 'iOS simulator TV target',
    device: {
      ...device,
      id: 'limrun:ios:tv',
      target: 'tv' as const,
    },
    legacy: LIMRUN_UNSUPPORTED_LIFECYCLE_CELL,
  },
] satisfies ReadonlyArray<
  Readonly<{ name: string; device: DeviceInfo; legacy: LegacyLifecycleCell }>
>;

test.each([
  {
    name: 'HarmonyOS device carrying an Android-shaped Limrun id',
    device: {
      ...device,
      platform: 'harmonyos' as const,
      appleOs: undefined,
      id: 'limrun:android:lease-a',
      kind: 'device' as const,
    },
  },
  {
    name: 'non-iOS Apple leaf',
    device: { ...device, appleOs: 'macos' as const, target: 'desktop' as const },
  },
  {
    name: 'physical Apple kind',
    device: { ...device, kind: 'device' as const },
  },
])('rejects exact binding for an impossible Limrun $name', async ({ device: invalidDevice }) => {
  const reconnect = vi.fn(async () => ({ status: 'missing' as const }));
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      reconnect,
    }),
  );

  await expect(
    owner.bind({
      device: invalidDevice,
      intent: {
        kind: 'exact-owner',
        owner: owner.owner,
        fence: { token: 'fence', generation: 1 },
      },
      scope,
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  expect(reconnect).not.toHaveBeenCalled();
});

test.each(LIMRUN_LIFECYCLE_DENOMINATOR)(
  'classifies the direct Limrun $name provider descriptor/dispatch cell',
  async ({ device: runtimeDevice, legacy }) => {
    const owner = createLimrunPlatformRuntimeOwner(
      limrunOwnerOptions({
        getInteractor: () => ({}) as Interactor,
      }),
    );
    const facts = await owner.inspectFacts(runtimeDevice);
    expectLifecycleFactAvailability(facts, legacy);
    if (!legacy.openTarget) {
      await expect(
        owner.bind({ device: runtimeDevice, intent: { kind: 'ordinary' }, scope }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_PLATFORM',
      });
      return;
    }
    const binding = await owner.bind({
      device: runtimeDevice,
      intent: { kind: 'ordinary' },
      scope,
    });
    expect(binding.facts.device.providerMode).toBe('provider-runtime');
    expect(binding.facts.operations.networkDump).toEqual({ available: true });
    expect(binding.facts.operations.ensureReady).toEqual({ available: true });
    expect(binding.facts.operations.bootTarget).toEqual({ available: true });
    expect(binding.facts.operations.bootTargetHeadless).toMatchObject({ available: false });
    expectLifecycleFacts(binding, legacy);
  },
);

test('a stale Limrun session publishes unavailable lifecycle facts and admits recovery only', async () => {
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({ hasLiveSession: () => false }),
  );

  const facts = await owner.inspectFacts(device);
  for (const operation of [
    'resolveOpenTarget',
    'prepareApplicationOpen',
    'openApplication',
    'closeApplication',
    'finalizeApplicationClose',
    'configureProviderPortReverse',
  ] as const) {
    expect(facts.operations[operation]).toMatchObject({
      available: false,
      reason: 'owner-capability-missing',
    });
  }

  await expect(owner.bind({ device, intent: { kind: 'ordinary' }, scope })).rejects.toThrow(
    /no longer live/,
  );

  // The durable app-log binding remains constructible under an exact-owner intent so it can
  // recover its own state; every other operation, lifecycle included, stays off the binding.
  const recovery = await owner.bind({
    device,
    intent: {
      kind: 'exact-owner',
      owner: owner.owner,
      fence: { token: 'fence', generation: 1 },
    },
    scope,
  });
  expect(Object.keys(recovery.operations).sort()).toEqual(['appLogCleanup', 'appLogReattach']);
});

test('a live Limrun lifecycle binding relaunches with its selected provider interactor only', async () => {
  const localInteractor = vi.fn(async () => {
    throw new Error('local interactor must not be reached for a provider-owned lifecycle');
  });
  const providerClose = vi.fn(async () => undefined);
  const providerOpen = vi.fn(async () => undefined);
  const baseHost = unusedHost();
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      host: {
        ...baseHost,
        localInteractors: { resolve: localInteractor },
      },
      getInteractor: () => ({ close: providerClose, open: providerOpen }) as unknown as Interactor,
      resolveAppReference: (_device, app) => (app === 'Example.app.zip' ? 'com.example.app' : app),
    }),
  );

  const binding = await owner.bind({
    device,
    intent: {
      kind: 'exact-owner',
      owner: owner.owner,
      fence: { token: 'provider-fence', generation: 1 },
    },
    scope,
  });

  await expect(
    binding.operations.resolveOpenTarget?.({ target: 'Example.app.zip', surface: 'app' }),
  ).resolves.toEqual({ appBundleId: 'com.example.app', appName: 'com.example.app' });
  await binding.operations.openApplication?.({
    target: 'Example.app.zip',
    positionals: ['Example.app.zip'],
    appBundleId: 'Example.app.zip',
    surface: 'app',
    hasExistingSession: true,
    relaunch: true,
    prewarmRunnerBeforeOpen: false,
    enableTestIme: false,
    stateDir: '/state',
    runtimeHints: {},
    execution: {},
  });
  expect(providerClose).toHaveBeenCalledWith('com.example.app');
  expect(providerOpen).toHaveBeenCalledWith(
    'com.example.app',
    expect.objectContaining({ appBundleId: 'com.example.app' }),
  );
  await binding.operations.closeApplication?.({
    positionals: ['Example.app.zip'],
    appBundleId: 'Example.app.zip',
    surface: 'app',
    execution: {},
  });
  expect(providerClose).toHaveBeenLastCalledWith('com.example.app');
  expect(localInteractor).not.toHaveBeenCalled();
});

function expectLifecycleFacts(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  // Independent legacy Limrun dispatch cell: only its exact iOS-simulator/Android-emulator
  // sessions had open/close behavior; provider-owned hints and Apple runner setup were absent.
  legacy: LegacyLifecycleCell = LIMRUN_SUPPORTED_IOS_LIFECYCLE_CELL,
): void {
  expectLifecycleFactAvailability(binding.facts, legacy);
  const operations = [
    ['openTarget', ['resolveOpenTarget', 'prepareApplicationOpen', 'openApplication']],
    ['prepareAppleRunner', ['prepareAppleRunner']],
    ['closeTarget', ['closeApplication', 'finalizeApplicationClose']],
    ['runtimeHints', ['applyRuntimeHints', 'clearRuntimeHints']],
    ['portReverse', ['configureProviderPortReverse']],
  ] as const;
  for (const [facet, names] of operations) {
    for (const name of names) {
      if (legacy[facet]) expect(binding.operations[name]).toBeTypeOf('function');
      else expect(binding.operations[name]).toBeUndefined();
    }
  }
}

function expectLifecycleFactAvailability(
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
}
