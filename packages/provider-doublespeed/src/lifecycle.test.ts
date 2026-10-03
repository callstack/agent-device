import type { DeviceBinding, RuntimeFacts } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import { createDoublespeedPlatformRuntimeOwner } from './app-log-runtime.ts';
import {
  doublespeedIosDevice as device,
  doublespeedOwnerOptions,
  doublespeedScope as scope,
  unusedDoublespeedHost as unusedHost,
} from './runtime.fixtures.ts';

type LifecycleCell = Readonly<{
  openTarget: boolean;
  prepareAppleRunner: boolean;
  closeTarget: boolean;
  runtimeHints: boolean;
  portReverse: boolean;
}>;

const SUPPORTED_CELL: LifecycleCell = {
  openTarget: true,
  prepareAppleRunner: false,
  closeTarget: true,
  runtimeHints: false,
  portReverse: false,
};
const UNSUPPORTED_CELL: LifecycleCell = {
  openTarget: false,
  prepareAppleRunner: false,
  closeTarget: false,
  runtimeHints: false,
  portReverse: false,
};
const DEVICE_KINDS = ['simulator', 'emulator', 'device'] as const;
const APPLE_LEAVES = [
  { appleOs: 'ios', target: 'mobile' },
  { appleOs: 'ipados', target: 'mobile' },
  { appleOs: 'tvos', target: 'tv' },
  { appleOs: 'macos', target: 'desktop' },
  { appleOs: 'visionos', target: 'mobile' },
  { appleOs: 'watchos', target: 'mobile' },
] as const;
const OTHER_FAMILIES = [
  { platform: 'android', target: 'mobile' },
  { platform: 'harmonyos', target: 'mobile' },
  { platform: 'vega', target: 'tv' },
  { platform: 'linux', target: 'desktop' },
  { platform: 'web', target: 'desktop' },
] as const;

// The provider has exactly one lifecycle dispatch cell: iOS-simulator/mobile. Every other
// canonical leaf/kind shape is fact-only and fails closed before a binding is constructed.
const LIFECYCLE_DENOMINATOR = [
  ...APPLE_LEAVES.flatMap(({ appleOs, target }) =>
    DEVICE_KINDS.map((kind) => ({
      name: `${appleOs} ${kind} ${target}`,
      device: {
        platform: 'apple' as const,
        appleOs,
        id: `doublespeed:ios:${appleOs}-${kind}`,
        name: `Doublespeed ${appleOs} ${kind}`,
        kind,
        target,
        booted: true,
      },
      cell:
        appleOs === 'ios' && kind === 'simulator' && target === 'mobile'
          ? SUPPORTED_CELL
          : UNSUPPORTED_CELL,
    })),
  ),
  ...OTHER_FAMILIES.flatMap(({ platform, target }) =>
    DEVICE_KINDS.map((kind) => ({
      name: `${platform} ${kind} ${target}`,
      device: {
        platform,
        id: `doublespeed:ios:${platform}-${kind}`,
        name: `Doublespeed ${platform} ${kind}`,
        kind,
        target,
        booted: true,
      },
      cell: UNSUPPORTED_CELL,
    })),
  ),
  {
    name: 'iOS simulator TV target',
    device: { ...device, id: 'doublespeed:ios:tv', target: 'tv' as const },
    cell: UNSUPPORTED_CELL,
  },
] satisfies ReadonlyArray<Readonly<{ name: string; device: DeviceInfo; cell: LifecycleCell }>>;

test.each(LIFECYCLE_DENOMINATOR)(
  'classifies the $name provider descriptor/dispatch cell',
  async ({ device: runtimeDevice, cell }) => {
    const owner = createDoublespeedPlatformRuntimeOwner(
      doublespeedOwnerOptions({ getInteractor: () => ({}) as Interactor }),
    );
    const facts = await owner.inspectFacts(runtimeDevice);
    expectLifecycleFactAvailability(facts, cell);
    if (!cell.openTarget) {
      await expect(
        owner.bind({ device: runtimeDevice, intent: { kind: 'ordinary' }, scope }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
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
    expect(binding.facts.operations.bootTargetHeadless).toMatchObject({ available: false });
    expectLifecycleFacts(binding, cell);
  },
);

test('a stale session publishes unavailable lifecycle facts and admits recovery only', async () => {
  const owner = createDoublespeedPlatformRuntimeOwner(
    doublespeedOwnerOptions({ hasLiveSession: () => false }),
  );
  const facts = await owner.inspectFacts(device);
  for (const operation of [
    'resolveOpenTarget',
    'openApplication',
    'closeApplication',
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
  const recovery = await owner.bind({
    device,
    intent: { kind: 'exact-owner', owner: owner.owner, fence: { token: 'fence', generation: 1 } },
    scope,
  });
  expect(Object.keys(recovery.operations).sort()).toEqual(['appLogCleanup', 'appLogReattach']);
});

test('a live lifecycle binding relaunches with its provider interactor only', async () => {
  const localInteractor = vi.fn(async () => {
    throw new Error('local interactor must not be reached for a provider-owned lifecycle');
  });
  const providerClose = vi.fn(async () => undefined);
  const providerOpen = vi.fn(async () => undefined);
  const baseHost = unusedHost();
  const owner = createDoublespeedPlatformRuntimeOwner(
    doublespeedOwnerOptions({
      host: { ...baseHost, localInteractors: { resolve: localInteractor } },
      getInteractor: () => ({ close: providerClose, open: providerOpen }) as unknown as Interactor,
    }),
  );
  const binding = await owner.bind({
    device,
    intent: { kind: 'exact-owner', owner: owner.owner, fence: { token: 'fence', generation: 1 } },
    scope,
  });
  await binding.operations.openApplication?.({
    target: 'com.example.app',
    positionals: ['com.example.app'],
    appBundleId: 'com.example.app',
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
  expect(localInteractor).not.toHaveBeenCalled();
  expect(binding.operations.configureProviderPortReverse).toBeUndefined();
});

const LIFECYCLE_OPERATIONS = [
  ['openTarget', ['resolveOpenTarget', 'prepareApplicationOpen', 'openApplication']],
  ['prepareAppleRunner', ['prepareAppleRunner']],
  ['closeTarget', ['closeApplication', 'finalizeApplicationClose']],
  ['runtimeHints', ['applyRuntimeHints', 'clearRuntimeHints']],
  ['portReverse', ['configureProviderPortReverse']],
] as const;

function expectLifecycleFacts(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  cell: LifecycleCell,
): void {
  expectLifecycleFactAvailability(binding.facts, cell);
  for (const [facet, names] of LIFECYCLE_OPERATIONS) {
    for (const name of names) {
      if (cell[facet]) expect(binding.operations[name]).toBeTypeOf('function');
      else expect(binding.operations[name]).toBeUndefined();
    }
  }
}

function expectLifecycleFactAvailability(
  facts: RuntimeFacts<PlatformRuntimeOperations>,
  cell: LifecycleCell,
): void {
  for (const [facet, names] of LIFECYCLE_OPERATIONS) {
    for (const name of names) expect(facts.operations[name].available).toBe(cell[facet]);
  }
}
