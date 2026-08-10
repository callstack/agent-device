import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  PlatformRequestScope,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import { providerRuntimeOwner } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { describe, expect, test, vi } from 'vitest';
import {
  createComposedPlatformRuntimeGateway,
  type PlatformRuntimeProviderRegistration,
} from './platform-runtime-gateway.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'limrun:ios:lease-a',
  name: 'Provider iOS',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};
const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

describe('composed platform runtime gateway', () => {
  test('selects an exact provider owner without ordinary ownsDevice arbitration', async () => {
    const ownsDevice = vi.fn(() => false);
    const ref = providerRuntimeOwner('limrun', 'stable');
    const runtime = providerRuntime({ ref, ownsDevice });
    const runtimeGateway = gateway([runtime]);

    const binding = await runtimeGateway.bind({
      device,
      intent: { kind: 'exact-owner', owner: ref, fence: { token: 'fence', generation: 1 } },
      scope,
    });
    expect(binding.owner).toEqual(ref);
    expect(ownsDevice).not.toHaveBeenCalled();
  });

  test('rejects ambiguous ordinary provider ownership', async () => {
    const first = providerRuntime({
      provider: 'first',
      ref: providerRuntimeOwner('first', 'stable'),
      ownsDevice: () => true,
    });
    const second = providerRuntime({
      provider: 'second',
      ref: providerRuntimeOwner('second', 'stable'),
      ownsDevice: () => true,
    });
    await expect(
      gateway([first, second]).bind({ device, intent: { kind: 'ordinary' }, scope }),
    ).rejects.toMatchObject({ details: { reason: 'runtime-contract-invalid' } });
  });

  test('rejects duplicate stable provider owner refs', async () => {
    const ref = providerRuntimeOwner('limrun', 'stable');
    expect(() => gateway([providerRuntime({ ref }), providerRuntime({ ref })])).toThrow(
      'Duplicate platform runtime owner',
    );
  });

  test('loads only the exact provider instance selected by stable owner metadata', async () => {
    const target = providerRuntimeOwner('limrun', 'target');
    const unrelatedLoad = vi.fn(async () => {
      throw new Error('must stay lazy');
    });
    const runtimeGateway = gateway([
      providerRuntime({ ref: providerRuntimeOwner('limrun', 'other'), load: unrelatedLoad }),
      providerRuntime({ ref: target, ownsDevice: () => false }),
    ]);
    await expect(
      runtimeGateway.bind({
        device,
        intent: { kind: 'exact-owner', owner: target, fence: { token: 'fence', generation: 1 } },
        scope,
      }),
    ).resolves.toMatchObject({ owner: target });
    expect(unrelatedLoad).not.toHaveBeenCalled();
  });

  test('does not fall back to a local runtime for a provider without an app-log module', async () => {
    const hostLoad = vi.fn(async () => ({}) as PlatformRuntimeHost);
    const localLoad = vi.fn(async () =>
      runtimeOwner({ ref: { kind: 'local-family', family: 'apple' } }),
    );
    const runtimeGateway = createComposedPlatformRuntimeGateway({
      modules: new Map([['apple', { family: 'apple', loadRuntime: localLoad }]]),
      loadHost: hostLoad,
      providerRuntimes: [
        {
          provider: 'webdriver',
          leaseLifecycle: {},
          deviceInventoryProvider: async () => null,
          ownsDevice: () => true,
          getInteractor: () => undefined,
          shutdown: async () => {},
        },
      ],
    });
    const binding = await runtimeGateway.bind({ device, intent: { kind: 'ordinary' }, scope });
    expect(binding.facts.operations.appLogInspect).toMatchObject({
      available: false,
      reason: 'unsupported-provider-mode',
    });
    expect(hostLoad).not.toHaveBeenCalled();
    expect(localLoad).not.toHaveBeenCalled();
  });

  test('rejects a swapped local module before loading host mechanics', async () => {
    const hostLoad = vi.fn(async () => ({}) as PlatformRuntimeHost);
    const runtimeGateway = createComposedPlatformRuntimeGateway({
      modules: new Map([
        [
          'apple',
          {
            family: 'android',
            loadRuntime: async () =>
              runtimeOwner({ ref: { kind: 'local-family', family: 'android' } }),
          },
        ],
      ]),
      loadHost: hostLoad,
    });
    await expect(
      runtimeGateway.bind({ device, intent: { kind: 'ordinary' }, scope }),
    ).rejects.toMatchObject({ details: { reason: 'runtime-contract-invalid' } });
    expect(hostLoad).not.toHaveBeenCalled();
  });

  test('accepts transport-composed facts from the selected local family owner', async () => {
    const ref = { kind: 'local-family', family: 'apple' } as const;
    const runtimeGateway = createComposedPlatformRuntimeGateway({
      modules: new Map([
        [
          'apple',
          {
            family: 'apple',
            loadRuntime: async () => runtimeOwner({ ref, providerMode: 'transport-composed' }),
          },
        ],
      ]),
      loadHost: async () => ({}) as PlatformRuntimeHost,
    });

    await expect(
      runtimeGateway.bind({ device, intent: { kind: 'ordinary' }, scope }),
    ).resolves.toMatchObject({
      owner: ref,
      facts: { device: { providerMode: 'transport-composed' } },
    });
  });

  test.each(['owner', 'device', 'facts'] as const)(
    'disposes a provider binding with mismatched %s identity',
    async (mismatch) => {
      const disposed = vi.fn(async () => {});
      const ref = providerRuntimeOwner('limrun', 'stable');
      const runtime = providerRuntime({ ref, mismatch, disposed });
      await expect(
        gateway([runtime]).bind({
          device,
          intent: { kind: 'exact-owner', owner: ref, fence: { token: 'fence', generation: 1 } },
          scope,
        }),
      ).rejects.toMatchObject({ details: { reason: 'runtime-contract-invalid' } });
      expect(disposed).toHaveBeenCalledOnce();
    },
  );
});

function gateway(registrations: readonly PlatformRuntimeProviderRegistration[]) {
  return createComposedPlatformRuntimeGateway({
    modules: new Map(),
    loadHost: async () => ({}) as PlatformRuntimeHost,
    providerRuntimes: registrations.map(({ runtime }) => runtime),
    providerModules: registrations,
  });
}

function providerRuntime(options: {
  ref: RuntimeOwnerRef;
  provider?: string;
  ownsDevice?: (device: DeviceInfo) => boolean;
  mismatch?: 'owner' | 'device' | 'facts';
  disposed?: () => Promise<void>;
  load?: () => Promise<PlatformRuntimeOwner>;
}): PlatformRuntimeProviderRegistration {
  const owner = runtimeOwner(options);
  const runtime: ProviderDeviceRuntime = {
    provider: options.provider ?? 'limrun',
    leaseLifecycle: {},
    deviceInventoryProvider: async () => null,
    ownsDevice: options.ownsDevice ?? (() => true),
    getInteractor: () => undefined,
    shutdown: async () => {},
  };
  return {
    runtime,
    module: {
      owner: options.ref as Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>,
      loadRuntime: options.load ?? (async () => owner),
    },
  };
}

function runtimeOwner(options: {
  ref: RuntimeOwnerRef;
  mismatch?: 'owner' | 'device' | 'facts';
  providerMode?: 'local' | 'transport-composed' | 'provider-runtime';
  disposed?: () => Promise<void>;
}): PlatformRuntimeOwner {
  return {
    owner: options.ref,
    ownsDevice: () => true,
    bind: async () => binding(options),
    shutdown: async () => {},
  };
}

function binding(options: {
  ref: RuntimeOwnerRef;
  mismatch?: 'owner' | 'device' | 'facts';
  providerMode?: 'local' | 'transport-composed' | 'provider-runtime';
  disposed?: () => Promise<void>;
}): DeviceBinding<PlatformRuntimeOperations> {
  const bindingDevice = options.mismatch === 'device' ? { ...device, id: 'wrong' } : device;
  const bindingOwner =
    options.mismatch === 'owner' ? providerRuntimeOwner('limrun', 'wrong') : options.ref;
  return {
    device: bindingDevice,
    owner: bindingOwner,
    facts: {
      device: {
        family: bindingDevice.platform,
        appleOs: bindingDevice.appleOs,
        kind: bindingDevice.kind,
        target: bindingDevice.target,
        providerMode:
          options.mismatch === 'facts'
            ? 'transport-composed'
            : (options.providerMode ?? 'provider-runtime'),
      },
      operations: unavailableFacts(),
    },
    operations: {},
    [Symbol.asyncDispose]: options.disposed ?? (async () => {}),
  };
}

function unavailableFacts() {
  const unavailable = { available: false, reason: 'unsupported-provider-mode' } as const;
  return {
    appLogInspect: unavailable,
    appLogDoctor: unavailable,
    appLogStart: unavailable,
    appLogReattach: unavailable,
    appLogCleanup: unavailable,
    networkDump: unavailable,
  };
}
