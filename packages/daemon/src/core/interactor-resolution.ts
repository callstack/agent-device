import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimeStateHandle } from '@agent-device/host-kit/request';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

/**
 * Resolves the interactor that speaks to a device — the provider-owned one when a
 * provider runtime holds the device, the local platform one otherwise. Callers ask it
 * instead of looking an interactor up themselves, so the daemon zone names no lookup.
 */
export type InteractorResolution = Readonly<{
  resolve(device: DeviceInfo, runnerContext: RunnerContext): Promise<Interactor>;
}>;

/**
 * The un-composed state, which is what a process that never ran root composition sees:
 * resolution fails closed rather than reaching for platform mechanics of its own.
 */
const NO_INTERACTOR_RESOLUTION: InteractorResolution = {
  resolve: async () => {
    throw new AppError(
      'COMMAND_FAILED',
      'Interactor resolution is not composed for this process.',
      {
        reason: 'interactor-resolution-missing',
      },
    );
  },
};

type InteractorResolutionState = { resolution: InteractorResolution };

const interactorResolutionStorage = new AsyncLocalStorage<InteractorResolutionState>();
const standaloneInteractorResolution: InteractorResolutionState = {
  resolution: NO_INTERACTOR_RESOLUTION,
};
const interactorResolutionState = (): InteractorResolutionState =>
  interactorResolutionStorage.getStore() ?? standaloneInteractorResolution;

/** The resolution one daemon runtime owns; the runtime installs its composition's into it. */
export function createInteractorResolutionRuntimeState(): RuntimeStateHandle {
  const owned: InteractorResolutionState = { resolution: NO_INTERACTOR_RESOLUTION };
  return {
    run: (fn) => interactorResolutionStorage.run(owned, fn),
    enter: () => interactorResolutionStorage.enterWith(owned),
    dispose: () => {},
  };
}

/**
 * Root composition's installation point, beside the provider-device admission that shares the
 * same request-scoped provider scope: one change names both. The interactor graph stays behind
 * the module root composition imports, and the daemon never loads it itself.
 */
export function installInteractorResolution(resolution: InteractorResolution): void {
  interactorResolutionState().resolution = resolution;
}

export function interactorResolution(): InteractorResolution {
  return interactorResolutionState().resolution;
}
