import type {
  DeviceInventoryRequest,
  ProviderDeviceInventorySource,
} from '@agent-device/contracts/device';
import {
  type DeviceInventorySource,
  type InventoryPlatformModule,
  createPlatformModuleRegistry,
} from '@agent-device/contracts/platform-module';
import type {
  DeviceInventoryHost,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import { PLATFORMS, type DeviceInfo, type Platform } from '@agent-device/kernel/device';
import { describe, expect, test, vi } from 'vitest';
import { createComposedDeviceInventoryGateways } from './platform-runtime-device-inventory.ts';

const scope: PlatformRequestScope = Object.freeze({
  signal: new AbortController().signal,
  diagnostics: Object.freeze({ emit: () => {} }),
  progress: Object.freeze({ report: () => {} }),
});

const host: DeviceInventoryHost = Object.freeze({
  commands: Object.freeze({
    which: async () => undefined,
    run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  }),
  appleTools: Object.freeze({
    isXcrunAvailable: async () => false,
    run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  }),
  toolchains: Object.freeze({ prepare: async () => {} }),
  files: Object.freeze({
    isExecutable: async () => false,
    createTemporaryTextFile: async () => {
      throw new Error('unused');
    },
  }),
  hostOs: 'darwin',
  hostName: 'test-host',
  homeDirectory: '/tmp/test-home',
  observations: Object.freeze({ deviceBooted: async () => {} }),
});

describe('composed device inventory gateway', () => {
  test('an authoritative provider inventory, including empty, loads no local host or source', async () => {
    for (const devices of [[], [device('android', 'remote')]]) {
      const local = inventoryWorld();
      const provider: ProviderDeviceInventorySource = {
        discover: async () => ({ kind: 'inventory', devices }),
      };
      const gateways = createComposedDeviceInventoryGateways({
        registry: local.registry,
        loadHost: local.loadHost,
        provider,
      });

      expect(await gateways.providerFirst.discover({ platform: 'android' }, scope)).toEqual(
        devices,
      );
      expect(local.hostLoads()).toBe(0);
      expect(local.sourceLoads()).toEqual([]);
    }
  });

  test('declined providers fall through, while malformed outcomes fail closed', async () => {
    const local = inventoryWorld();
    const declined = createComposedDeviceInventoryGateways({
      registry: local.registry,
      loadHost: local.loadHost,
      provider: { discover: async () => ({ kind: 'declined' }) },
    });
    expect(await declined.providerFirst.discover({ platform: 'android' }, scope)).toEqual([
      device('android'),
    ]);

    const malformed = createComposedDeviceInventoryGateways({
      registry: local.registry,
      loadHost: local.loadHost,
      provider: { discover: async () => undefined } as unknown as ProviderDeviceInventorySource,
    });
    await expect(
      malformed.providerFirst.discover({ platform: 'android' }, scope),
    ).rejects.toMatchObject({ details: { reason: 'provider_inventory_contract_violation' } });
  });

  test('forwards the request signal into an in-flight provider source', async () => {
    const controller = new AbortController();
    const requestScope = { ...scope, signal: controller.signal };
    const observed = vi.fn();
    const provider: ProviderDeviceInventorySource = {
      discover: async (_request, signal) => {
        observed(signal);
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };
    const local = inventoryWorld();
    const gateways = createComposedDeviceInventoryGateways({
      registry: local.registry,
      loadHost: local.loadHost,
      provider,
    });
    const pending = gateways.providerFirst.discover({ platform: 'android' }, requestScope);
    controller.abort(new Error('cancelled'));

    await expect(pending).rejects.toThrow('cancelled');
    expect(observed).toHaveBeenCalledWith(controller.signal);
    expect(local.hostLoads()).toBe(0);
  });

  test('keeps local projection policy out of the provider request', async () => {
    const received: unknown[] = [];
    const provider: ProviderDeviceInventorySource = {
      discover: async (request) => {
        received.push(request);
        return { kind: 'inventory', devices: [] };
      },
    };
    const local = inventoryWorld();
    const gateways = createComposedDeviceInventoryGateways({
      registry: local.registry,
      loadHost: local.loadHost,
      provider,
    });

    await gateways.providerFirst.discover(
      {
        platform: 'ios',
        kind: 'simulator',
        booted: true,
        iosSimulatorSetPath: '/tmp/isolated-simulators',
        androidSerialAllowlist: ['emulator-5554'],
      },
      scope,
    );

    expect(received).toEqual([
      {
        platform: 'ios',
        iosSimulatorSetPath: '/tmp/isolated-simulators',
        androidSerialAllowlist: ['emulator-5554'],
      },
    ]);
    expect(local.hostLoads()).toBe(0);
  });

  test('applies public Apple aliases and all internal projection filters centrally', async () => {
    const devices = [
      { ...device('apple', 'ios-default'), appleOs: 'ios' as const, target: undefined },
      { ...device('apple', 'mac'), appleOs: 'macos' as const, target: 'desktop' as const },
      { ...device('apple', 'shutdown'), appleOs: 'ios' as const, booted: false },
      device('android', 'other-family'),
    ];
    const provider: ProviderDeviceInventorySource = {
      discover: async () => ({ kind: 'inventory', devices }),
    };
    const local = inventoryWorld();
    const gateways = createComposedDeviceInventoryGateways({
      registry: local.registry,
      loadHost: local.loadHost,
      provider,
    });

    const projected = await gateways.providerFirst.discover(
      { platform: 'ios', target: 'mobile', kind: 'device', booted: true },
      scope,
    );
    expect(projected.map(({ id }) => id)).toEqual(['ios-default']);
  });

  test('loads only the selected family and retries failed host and source loads', async () => {
    let hostAttempts = 0;
    let androidAttempts = 0;
    const local = inventoryWorld({
      android: async () => {
        androidAttempts += 1;
        if (androidAttempts === 1) throw new Error('source load failed');
        return source([device('android')]);
      },
    });
    const gateways = createComposedDeviceInventoryGateways({
      registry: local.registry,
      loadHost: async () => {
        hostAttempts += 1;
        if (hostAttempts === 1) throw new Error('host load failed');
        return host;
      },
    });

    await expect(gateways.localOnly.discover({ platform: 'android' }, scope)).rejects.toThrow(
      'host load failed',
    );
    await expect(gateways.localOnly.discover({ platform: 'android' }, scope)).rejects.toThrow(
      'source load failed',
    );
    expect(await gateways.localOnly.discover({ platform: 'android' }, scope)).toEqual([
      device('android'),
    ]);
    expect(hostAttempts).toBe(2);
    expect(androidAttempts).toBe(2);
    expect(local.sourceLoads()).toEqual(['android', 'android']);
  });

  test('unfiltered local discovery is fail-soft and preserves selector order', async () => {
    const local = inventoryWorld({
      harmonyos: async () => source([], new Error('hdc unavailable')),
    });
    const gateways = createComposedDeviceInventoryGateways({
      registry: local.registry,
      loadHost: local.loadHost,
    });

    const devices = await gateways.localOnly.discover({}, scope);
    expect(devices.map(({ platform }) => platform)).toEqual(['android', 'apple', 'vega', 'linux']);
    expect(local.sourceLoads()).toEqual(['android', 'harmonyos', 'apple', 'vega', 'linux']);
  });

  test('explicit local failures propagate and family sources cannot return another family', async () => {
    const failing = inventoryWorld({ android: async () => source([], new Error('adb failed')) });
    await expect(
      createComposedDeviceInventoryGateways({
        registry: failing.registry,
        loadHost: failing.loadHost,
      }).localOnly.discover({ platform: 'android' }, scope),
    ).rejects.toThrow('adb failed');

    const lying = inventoryWorld({
      android: async () => source([device('linux', 'wrong-family')]),
    });
    await expect(
      createComposedDeviceInventoryGateways({
        registry: lying.registry,
        loadHost: lying.loadHost,
      }).localOnly.discover({ platform: 'android' }, scope),
    ).rejects.toMatchObject({
      details: { expectedFamily: 'android', actualFamily: 'linux' },
    });
  });
});

function inventoryWorld(
  overrides: Partial<Record<Platform, () => Promise<DeviceInventorySource>>> = {},
) {
  const loaded: Platform[] = [];
  let hosts = 0;
  const modules: InventoryPlatformModule[] = PLATFORMS.map((family) => ({
    family,
    loadInventory: async () => {
      loaded.push(family);
      return await (overrides[family]?.() ?? Promise.resolve(source([device(family)])));
    },
  }));
  return {
    registry: createPlatformModuleRegistry(modules),
    loadHost: async () => {
      hosts += 1;
      return host;
    },
    hostLoads: () => hosts,
    sourceLoads: () => [...loaded],
  };
}

function source(devices: readonly DeviceInfo[], failure?: Error): DeviceInventorySource {
  return {
    discover: async (_request: Readonly<DeviceInventoryRequest>) => {
      if (failure) throw failure;
      return devices;
    },
  };
}

function device(platform: Platform, id = `${platform}-device`): DeviceInfo {
  return {
    platform,
    id,
    name: id,
    kind: 'device',
    target: platform === 'vega' ? 'tv' : 'mobile',
    booted: true,
  };
}
