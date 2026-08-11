import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interaction';
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
import { createLimrunRuntime, type LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import { describe, expect, test, vi } from 'vitest';
import { handleSessionStateCommands } from './daemon/handlers/session-state.ts';
import { createRequestRuntimeBindings } from './daemon/request-runtime-binding.ts';
import { makeSessionStore } from './__tests__/test-utils/store-factory.ts';
import { withTestDeviceInventory } from './__tests__/test-utils/device-inventory-gateways.ts';
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
  test('inspects only the selected lazy owner and does not bind it', async () => {
    const selectedRef = providerRuntimeOwner('limrun', 'selected');
    const selectedOwner = runtimeOwner({ ref: selectedRef });
    const inspectFacts = vi.spyOn(selectedOwner, 'inspectFacts');
    const bind = vi.spyOn(selectedOwner, 'bind');
    const unrelatedLoad = vi.fn(async () => {
      throw new Error('must stay lazy');
    });
    const runtimeGateway = gateway([
      providerRuntime({
        ref: providerRuntimeOwner('limrun', 'unrelated'),
        ownsDevice: () => false,
        load: unrelatedLoad,
      }),
      providerRuntime({ ref: selectedRef, load: async () => selectedOwner }),
    ]);

    await expect(runtimeGateway.inspectFacts(device)).resolves.toMatchObject({
      operations: { ensureReady: { available: false } },
    });

    expect(inspectFacts).toHaveBeenCalledOnce();
    expect(bind).not.toHaveBeenCalled();
    expect(unrelatedLoad).not.toHaveBeenCalled();
  });

  test('keeps a stale Limrun Android id unavailable through the production handler without binding or local fallback', async () => {
    const registration = createLimrunRuntime(
      { apiKey: 'test-key', runtimeInstance: 'test-instance' },
      limrunTestDependencies,
      { includePlatformModule: true },
    );
    const staleDevice: DeviceInfo = {
      platform: 'android',
      id: 'limrun:android:released-lease',
      name: 'Released Limrun Android',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    };
    let inspectCount = 0;
    let bindCount = 0;
    const providerModule = {
      ...registration.platformModule,
      loadRuntime: async (host: PlatformRuntimeHost) => {
        const owner = await registration.platformModule.loadRuntime(host);
        return {
          ...owner,
          inspectFacts: async (device: DeviceInfo) => {
            inspectCount += 1;
            return await owner.inspectFacts(device);
          },
          bind: async (request: Parameters<PlatformRuntimeOwner['bind']>[0]) => {
            bindCount += 1;
            return await owner.bind(request);
          },
        };
      },
    };
    const localLoad = vi.fn(async () => {
      throw new Error('stale Limrun identity must not fall back to local Android');
    });
    const runtimeGateway = createComposedPlatformRuntimeGateway({
      modules: new Map([['android', { family: 'android', loadRuntime: localLoad }]]),
      loadHost: async () => ({}) as PlatformRuntimeHost,
      providerRuntimes: [registration.runtime],
      providerModules: [{ runtime: registration.runtime, module: providerModule }],
    });

    const bindings = createRequestRuntimeBindings({ gateway: runtimeGateway, scope });
    try {
      const response = await withTestDeviceInventory(
        { local: async () => [staleDevice] },
        async () =>
          await handleSessionStateCommands({
            req: {
              token: 't',
              session: 'default',
              command: 'appstate',
              positionals: [],
              flags: { platform: 'android', device: staleDevice.name },
            },
            sessionName: 'default',
            sessionStore: makeSessionStore('agent-device-stale-limrun-'),
            inspectFacts: bindings.inspectFacts,
            bindDevice: bindings.bindDevice,
          }),
      );

      expect(response?.ok).toBe(false);
      if (response && !response.ok) {
        expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
        expect(response.error.hint).toMatch(/matching live provider session/i);
      }
      expect(inspectCount).toBe(1);
      expect(bindCount).toBe(0);
      expect(localLoad).not.toHaveBeenCalled();
    } finally {
      await bindings[Symbol.asyncDispose]();
      await runtimeGateway.shutdown();
      await registration.runtime.shutdown();
    }
  });

  test('rejects inspected facts with a provider-mode mismatch', async () => {
    const ref = providerRuntimeOwner('limrun', 'stable');
    await expect(
      gateway([providerRuntime({ ref, mismatch: 'facts' })]).inspectFacts(device),
    ).rejects.toMatchObject({ details: { reason: 'runtime-contract-invalid' } });
  });

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
    expect(binding.facts.operations.listApps).toMatchObject({
      available: false,
      reason: 'unsupported-provider-mode',
    });
    expect(binding.facts.operations.appState).toMatchObject({
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
    inspectFacts: async () => binding(options).facts,
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
    appState: unavailable,
    networkDump: unavailable,
    screenRecordingStart: unavailable,
    screenRecordingReattach: unavailable,
    screenRecordingCleanup: unavailable,
    ensureReady: unavailable,
    bootTarget: unavailable,
    bootTargetHeadless: unavailable,
    listApps: unavailable,
  };
}

const limrunTestDependencies = {
  clientVersion: 'test',
  android: {
    createInteractor: () => ({}) as Interactor,
    createPortReverse: async () => ({
      ensure: async () => {},
      remove: async () => {},
      removeAllOwned: async () => {},
    }),
    inferAppName: async () => 'unused',
    listApps: async () => [],
    getForegroundApp: async () => undefined,
    getKeyboardState: async () => ({ visible: false, inputOwner: 'unknown' as const }),
    dismissKeyboard: async () => ({
      visible: false,
      inputOwner: 'unknown' as const,
      attempts: 0,
      wasVisible: false,
      dismissed: false,
    }),
    readLogs: async () => '',
    adbError: async () => {
      throw new Error('unused');
    },
  },
  host: {
    runAdb: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    archiveDirectory: async () => {},
  },
  ios: {
    resolveAppAlias: async (app: string) => app,
    readBundleAppName: async () => undefined,
  },
} satisfies LimrunRuntimeDependencies;
