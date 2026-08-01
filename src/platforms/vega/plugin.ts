import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import type { PlatformPlugin } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';

const VEGA_VVD_ONLY_COMMANDS = [
  PUBLIC_COMMANDS.open,
  PUBLIC_COMMANDS.close,
  PUBLIC_COMMANDS.back,
  PUBLIC_COMMANDS.home,
  PUBLIC_COMMANDS.tvRemote,
] as const;

// The descriptor's `vega.emulator` bucket owns device kind; this plugin adds the
// semantic TV-target gate. The full predicate remains necessary for the physical-device hint.
const isVegaTvTarget = (device: DeviceInfo): boolean => device.target === 'tv';
const isVegaVvd = (device: DeviceInfo): boolean =>
  device.kind === 'emulator' && isVegaTvTarget(device);

const VEGA_SUPPORTS_BY_DEFAULT = Object.fromEntries(
  VEGA_VVD_ONLY_COMMANDS.map((command) => [command, isVegaTvTarget]),
);

const VEGA_UNSUPPORTED_HINT_BY_DEFAULT = Object.fromEntries(
  VEGA_VVD_ONLY_COMMANDS.map((command) => [
    command,
    (device: DeviceInfo) =>
      isVegaVvd(device) ? undefined : `${command} currently supports only Vega Virtual Devices.`,
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
