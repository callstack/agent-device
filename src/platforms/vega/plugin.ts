import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';
import type { DeviceInfo } from '@agent-device/kernel/device';

export const vegaPlugin = {
  id: 'vega',
  platforms: ['vega'],
  providers: { platformGatedResolvers: ['vegaToolProvider'] },
  createInteractor: async (
    device: DeviceInfo,
    runnerContext: RunnerContext,
  ): Promise<Interactor> => {
    const { createVegaInteractor } = await import('./interactor.ts');
    return createVegaInteractor(device, runnerContext);
  },
} as const satisfies PlatformPlugin;
