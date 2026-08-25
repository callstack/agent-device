import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one app-switcher reveal: no arguments, so only runner metadata travels —
 * the same shape `home` carries, because it is the same springboard surface.
 */
export type AppSwitcherInput = Readonly<{
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/** The reveal returns nothing; the retired leaf discarded whatever the interactor answered. */
export type AppSwitcherRuntimeOperations = Readonly<{
  appSwitcher(input: AppSwitcherInput): Promise<void>;
}>;

export type AppSwitcherRuntimeOperationFacts = Readonly<{
  appSwitcher: RuntimeOperationFact;
}>;

export function appSwitcherRuntimeOperationFacts(
  input: Readonly<{ appSwitcher: RuntimeOperationFact }>,
): AppSwitcherRuntimeOperationFacts {
  return Object.freeze({ appSwitcher: input.appSwitcher });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the reveal itself.
 */
export function bindAppSwitcher(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): AppSwitcherRuntimeOperations {
  return Object.freeze({
    appSwitcher: async (input: AppSwitcherInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      await interactor.appSwitcher();
    },
  });
}
