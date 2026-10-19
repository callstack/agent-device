import { defineRuntimeSlots, type RuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
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

const interactorResolutionRuntime = defineRuntimeSlots();
const INTERACTOR_RESOLUTION_SLOT = Symbol('interactorResolution');
const interactorResolutionState = (): InteractorResolutionState =>
  interactorResolutionRuntime.slot(INTERACTOR_RESOLUTION_SLOT, (): InteractorResolutionState => ({
    resolution: NO_INTERACTOR_RESOLUTION,
  }));

/** The resolution one daemon runtime owns; the runtime installs its composition's into it. */
export const createInteractorResolutionRuntimeState = (): RuntimeStateHandle =>
  interactorResolutionRuntime.createHandle();

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
