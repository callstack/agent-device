import type { DeviceRotation } from './device-rotation.ts';
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

export type OrientationRuntimeOperations = Readonly<{
  setOrientation(input: SetOrientationInput): Promise<SetOrientationResult | void>;
}>;

export type OrientationRuntimeOperationFacts = Readonly<{
  setOrientation: RuntimeOperationFact;
}>;

export function orientationRuntimeOperationFacts(
  input: Readonly<{ orientation: RuntimeOperationFact }>,
): OrientationRuntimeOperationFacts {
  return Object.freeze({ setOrientation: input.orientation });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the rotation itself.
 */
export function bindOrientation(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): OrientationRuntimeOperations {
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
