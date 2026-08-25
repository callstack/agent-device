import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { TvRemoteButton } from './tv-remote.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one TV remote button press. `button` and `durationMs` are already parsed
 * and range-validated by the caller; the operation names no command, request, session, or CLI
 * flag.
 */
export type TvRemoteInput = Readonly<{
  button: TvRemoteButton;
  durationMs?: number;
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * TV remote returns nothing. The legacy leaf discarded whatever the interactor answered and
 * reported only the button it pressed, so a result type here would be a surface the command
 * never had.
 */
export type TvRemoteRuntimeOperations = Readonly<{
  tvRemote(input: TvRemoteInput): Promise<void>;
}>;

export type TvRemoteRuntimeOperationFacts = Readonly<{
  tvRemote: RuntimeOperationFact;
}>;

export function tvRemoteRuntimeOperationFacts(
  input: Readonly<{ tvRemote: RuntimeOperationFact }>,
): TvRemoteRuntimeOperationFacts {
  return Object.freeze({ tvRemote: input.tvRemote });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the button press itself.
 */
export function bindTvRemote(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): TvRemoteRuntimeOperations {
  return Object.freeze({
    tvRemote: async (input: TvRemoteInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      await interactor.tvRemote(input.button, input.durationMs);
    },
  });
}
