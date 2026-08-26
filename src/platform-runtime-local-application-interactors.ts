import type { LocalApplicationInteractorHost } from '@agent-device/contracts/application-lifecycle-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RunnerContext } from '@agent-device/contracts/interactor-types';

/** Lazy local interactor construction; package bindings decide when it is needed. */
export function createLocalApplicationInteractorHost(): LocalApplicationInteractorHost {
  return Object.freeze({
    resolve: async (device: DeviceInfo, runner: RunnerContext) => {
      const { getLocalInteractor } = await import('./core/interactors.ts');
      return await getLocalInteractor(device, runner);
    },
  });
}
