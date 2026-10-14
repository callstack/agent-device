import type { DeviceRotation } from './device-rotation.ts';
import { requireInteractorMethod } from './interactor-operation-binding.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one orientation change. `rotation` is already parsed by the caller
 * (`parseDeviceRotation`); the operation names no command, request, session, or CLI flag.
 */
export type SetOrientationInput = Readonly<{
  rotation: DeviceRotation;
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * The interactor's own closed result: the rotation it actually reports, or nothing when the
 * owner does not echo one back (the legacy leaf fell back to the requested rotation in that case).
 */
export type SetOrientationResult = Readonly<{ orientation?: DeviceRotation }>;

/**
 * Neutral intent for handing rotation back to the device sensor (`orientation auto`). Carries
 * runner metadata only: the mode is which operation the daemon binds, never an argument here.
 */
export type UnlockOrientationInput = Readonly<{
  options?: Readonly<{ appBundleId?: string }>;
  execution?: SnapshotRuntimeExecution;
}>;

export type OrientationRuntimeOperations = Readonly<{
  setOrientation(input: SetOrientationInput): Promise<SetOrientationResult | void>;
  unlockOrientation(input: UnlockOrientationInput): Promise<void>;
}>;

export type OrientationRuntimeOperationFacts = Readonly<{
  setOrientation: RuntimeOperationFact;
  unlockOrientation: RuntimeOperationFact;
}>;

/**
 * Both cells are stated by every owner: a fixed rotation and the sensor hand-back are different
 * mechanisms (ADB writes two system settings for one and clears one for the other; no other
 * backend exposes a hand-back), so neither fact is derived from the other.
 */
export function orientationRuntimeOperationFacts(
  input: Readonly<{ orientation: RuntimeOperationFact; unlock: RuntimeOperationFact }>,
): OrientationRuntimeOperationFacts {
  return Object.freeze({ setOrientation: input.orientation, unlockOrientation: input.unlock });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the rotation itself.
 */
export function bindOrientation(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): Pick<OrientationRuntimeOperations, 'setOrientation'> {
  return Object.freeze({
    setOrientation: async (input: SetOrientationInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      return await interactor.setOrientation(input.rotation);
    },
  });
}

/**
 * Binds the sensor hand-back the same way. `unlockOrientation` is an optional interactor member;
 * facts admit it only for owners that implement it, so a missing method at call time is a
 * runtime-contract error, never a successful no-op (parity with the system-button binder).
 */
export function bindOrientationUnlock(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): Pick<OrientationRuntimeOperations, 'unlockOrientation'> {
  return Object.freeze({
    unlockOrientation: async (input: UnlockOrientationInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      await requireInteractorMethod(interactor.unlockOrientation, 'orientation auto').call(
        interactor,
      );
    },
  });
}
