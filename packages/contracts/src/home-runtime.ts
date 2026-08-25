import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/** Neutral intent for one home navigation: no arguments, so only runner metadata travels. */
export type HomeInput = Readonly<{
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/** Home returns nothing; the legacy leaf discarded whatever the interactor answered. */
export type HomeRuntimeOperations = Readonly<{
  home(input: HomeInput): Promise<void>;
}>;

export type HomeRuntimeOperationFacts = Readonly<{
  home: RuntimeOperationFact;
}>;

export function homeRuntimeOperationFacts(
  input: Readonly<{ home: RuntimeOperationFact }>,
): HomeRuntimeOperationFacts {
  return Object.freeze({ home: input.home });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the navigation itself.
 */
export function bindHome(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): HomeRuntimeOperations {
  return Object.freeze({
    home: async (input: HomeInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      await interactor.home();
    },
  });
}
