import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  localInteractorSource,
  providerInteractorSource,
  type LocalInteractorOperationResolver,
  type ProviderInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import type { BackMode, Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one back navigation. `mode` is already validated by the caller (the
 * `--mode` flag); the operation names no command, request, session, or CLI flag.
 */
export type BackInput = Readonly<{
  mode?: BackMode;
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * Back returns nothing. The legacy leaf discarded whatever the interactor answered and reported
 * only the mode it requested, so a result type here would be a surface the command never had.
 */
export type BackRuntimeOperations = Readonly<{
  back(input: BackInput): Promise<void>;
}>;

export type BackRuntimeOperationFacts = Readonly<{
  back: RuntimeOperationFact;
}>;

export function backRuntimeOperationFacts(
  input: Readonly<{ back: RuntimeOperationFact }>,
): BackRuntimeOperationFacts {
  return Object.freeze({ back: input.back });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the navigation itself.
 */
function bindBack(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): BackRuntimeOperations {
  return Object.freeze({
    back: async (input: BackInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      await interactor.back(input.mode);
    },
  });
}

export type LocalBackInteractorResolver = LocalInteractorOperationResolver;

export function bindLocalBackInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalBackInteractorResolver;
  }>,
): BackRuntimeOperations {
  return bindBack(params.signal, localInteractorSource(params));
}

export type ProviderBackInteractorResolver = ProviderInteractorOperationResolver;

/** Provider bindings fail closed when their exact owner no longer exposes its interactor. */
export function bindProviderBackInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ProviderBackInteractorResolver;
  }>,
): BackRuntimeOperations {
  return bindBack(params.signal, providerInteractorSource({ ...params, operation: 'back' }));
}
