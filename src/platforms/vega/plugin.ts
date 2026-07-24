import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { DeviceInventoryRequest } from '../../contracts/device-inventory.ts';
import type { Interactor, RunnerContext } from '../../core/interactor-types.ts';
import type { PlatformPlugin } from '../../core/platform-plugin/plugin.ts';
import type { DeviceInfo } from '../../kernel/device.ts';

const VEGA_VVD_ONLY_COMMANDS = [
  PUBLIC_COMMANDS.open,
  PUBLIC_COMMANDS.close,
  PUBLIC_COMMANDS.back,
  PUBLIC_COMMANDS.home,
  PUBLIC_COMMANDS.tvRemote,
] as const;

const VEGA_SUPPORTS_BY_DEFAULT = Object.fromEntries(
  VEGA_VVD_ONLY_COMMANDS.map((command) => [
    command,
    (device: DeviceInfo) => device.kind === 'emulator' && device.target === 'tv',
  ]),
);

const VEGA_UNSUPPORTED_HINT_BY_DEFAULT = Object.fromEntries(
  VEGA_VVD_ONLY_COMMANDS.map((command) => [
    command,
    (device: DeviceInfo) =>
      device.kind === 'emulator' && device.target === 'tv'
        ? undefined
        : `${command} currently supports only Vega Virtual Devices.`,
  ]),
);

export const vegaPlugin = {
  id: 'vega',
  platforms: ['vega'],
  capability: {
    bucket: 'vega',
    supportsByDefault: VEGA_SUPPORTS_BY_DEFAULT,
    unsupportedHintByDefault: VEGA_UNSUPPORTED_HINT_BY_DEFAULT,
  },
  providers: { platformGatedResolvers: ['vegaToolProvider'] },
  createInteractor: async (
    device: DeviceInfo,
    runnerContext: RunnerContext,
  ): Promise<Interactor> => {
    const { createVegaInteractor } = await import('./interactor.ts');
    return createVegaInteractor(device, runnerContext);
  },
  discoverDevices: async (_request: DeviceInventoryRequest): Promise<DeviceInfo[]> => {
    const { listVegaDevices } = await import('./devices.ts');
    return await listVegaDevices();
  },
} as const satisfies PlatformPlugin;
