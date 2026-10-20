import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { HardwareKeyToken } from './hardware-key.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one hardware key press. `key` is already parsed and validated by the
 * caller; the operation names no command, request, session, or CLI flag.
 */
export type HardwareKeyInput = Readonly<{
  key: HardwareKeyToken;
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * A hardware key press returns nothing. The Android interactor answers with the adb result and
 * every caller discards it, so a result type here would be a surface the command never had.
 */
export type HardwareKeyRuntimeOperations = Readonly<{
  hardwareKey(input: HardwareKeyInput): Promise<void>;
}>;

export type HardwareKeyRuntimeOperationFacts = Readonly<{
  hardwareKey: RuntimeOperationFact;
}>;

export function hardwareKeyRuntimeOperationFacts(
  input: Readonly<{ hardwareKey: RuntimeOperationFact }>,
): HardwareKeyRuntimeOperationFacts {
  return Object.freeze({ hardwareKey: input.hardwareKey });
}

/** How a fail-closed refusal names the hardware key press to the caller, matching the command. */
export const HARDWARE_KEY_LABEL = 'hardware-key';

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding and
 * presses one hardware key through it. Owners without a key-event channel refuse through facts,
 * so a missing interactor method at press time is a runtime-contract error, not a normal refusal.
 */
export function bindHardwareKey(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): HardwareKeyRuntimeOperations {
  return Object.freeze({
    hardwareKey: async (input: HardwareKeyInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      // Loaded on the call rather than at module evaluation because the façades reaching this
      // binder hold their eager closure at merge-base size (`eager-closure-budgets`); a static
      // edge would grow it.
      const { requireInteractorMethod } = await import('./interactor-operation-binding.ts');
      const hardwareKey = requireInteractorMethod(interactor.hardwareKey, HARDWARE_KEY_LABEL);
      await hardwareKey.call(interactor, input.key);
    },
  });
}
