import {
  type DeviceInventoryProvider,
  type DeviceInventoryRequest,
  type ProviderDeviceInventorySource,
} from '@agent-device/contracts/device';
import {
  type AppDeviceResolver,
  type ComposedDeviceInventoryGateways,
  type DeviceInventorySource,
  type InstalledAppProbe,
  type InventoryPlatformModule,
  createPlatformModuleRegistry,
} from '@agent-device/contracts/platform-module';
import type {
  DeviceInventoryHost,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo, Platform } from '@agent-device/kernel/device';
import { createComposedDeviceInventoryGateways } from './composed-inventory-gateways.ts';
import { withDeviceInventoryContext } from './device-inventory-context.ts';

export type TestDeviceInventoryOptions = Readonly<{
  provider?: ProviderDeviceInventorySource;
  local?: (request: Readonly<DeviceInventoryRequest>) => Promise<readonly DeviceInfo[]>;
  findInstalledApp?: InstalledAppProbe;
  resolveAppDevice?: AppDeviceResolver;
}>;

export const testRequestScope: PlatformRequestScope = Object.freeze({
  signal: new AbortController().signal,
  diagnostics: Object.freeze({ emit: () => {} }),
  progress: Object.freeze({ report: () => {} }),
});

export const testInventoryHost: DeviceInventoryHost = Object.freeze({
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
      throw new Error('unused test inventory temporary file');
    },
  }),
  hostOs: 'other',
  hostName: 'test-host',
  homeDirectory: '/tmp/test-home',
  observations: Object.freeze({ deviceBooted: async () => {} }),
});

function testInventoryModules(
  discover: (request: Readonly<DeviceInventoryRequest>) => Promise<readonly DeviceInfo[]>,
): readonly InventoryPlatformModule[] {
  const source = (family: Platform): DeviceInventorySource => ({
    discover: async (request) =>
      (await discover(request)).filter((device) => device.platform === family),
  });
  return [
    { family: 'apple', loadInventory: async () => source('apple') },
    { family: 'android', loadInventory: async () => source('android') },
    { family: 'harmonyos', loadInventory: async () => source('harmonyos') },
    { family: 'vega', loadInventory: async () => source('vega') },
    { family: 'linux', loadInventory: async () => source('linux') },
    { family: 'web', loadInventory: async () => source('web') },
  ];
}

export function createTestDeviceInventoryGateways(
  options: TestDeviceInventoryOptions = {},
): ComposedDeviceInventoryGateways {
  return createComposedDeviceInventoryGateways({
    registry: createPlatformModuleRegistry(
      testInventoryModules(options.local ?? (async () => [] as readonly DeviceInfo[])),
    ),
    loadHost: async () => testInventoryHost,
    provider: options.provider,
    findInstalledApp: options.findInstalledApp,
    resolveAppDevice: options.resolveAppDevice,
  });
}

/** Test-only bridge for fixtures that still implement the public nullable provider port. */
export function createTestDeviceInventoryGatewaysFromProvider(
  provider: DeviceInventoryProvider,
): ComposedDeviceInventoryGateways {
  return createTestDeviceInventoryGateways({
    provider: {
      discover: async (request, signal) => {
        signal.throwIfAborted();
        const devices = await provider(request, signal);
        return devices === null || devices === undefined
          ? { kind: 'declined' }
          : { kind: 'inventory', devices };
      },
    },
  });
}

export async function withTestDeviceInventory<T>(
  options: TestDeviceInventoryOptions,
  task: () => Promise<T>,
): Promise<T> {
  return await withDeviceInventoryContext(
    { ...createTestDeviceInventoryGateways(options), requestScope: testRequestScope },
    task,
  );
}

export async function withTestDeviceInventoryProvider<T>(
  provider: DeviceInventoryProvider,
  task: () => Promise<T>,
): Promise<T> {
  return await withDeviceInventoryContext(
    { ...createTestDeviceInventoryGatewaysFromProvider(provider), requestScope: testRequestScope },
    task,
  );
}
