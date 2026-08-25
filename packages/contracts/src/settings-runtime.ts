import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SettingOptions } from './settings.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * Neutral intent for one settings mutation. `setting` and `state` are the device-settings
 * vocabulary the owner's own API is keyed by (`interactor.setSetting`), not a command payload:
 * the daemon has already parsed the CLI form, validated it, resolved the target app, and typed
 * the coordinates in `options`, so nothing command-shaped or argv-shaped travels here.
 */
export type SetSettingInput = Readonly<{
  setting: string;
  state: string;
  /** The app the setting targets, already resolved from the request or the session. */
  appBundleId?: string;
  options?: SettingOptions;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * Owners answer with their own settings payload or nothing at all; the daemon composes the
 * response text around whichever it gets, exactly as the retired leaf did.
 */
export type SettingsRuntimeOperations = Readonly<{
  setSetting(input: SetSettingInput): Promise<Record<string, unknown> | void>;
}>;

export type SettingsRuntimeOperationFacts = Readonly<{
  setSetting: RuntimeOperationFact;
}>;

export function settingsRuntimeOperationFacts(
  input: Readonly<{ setSetting: RuntimeOperationFact }>,
): SettingsRuntimeOperationFacts {
  return Object.freeze({ setSetting: input.setSetting });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the mutation itself.
 */
export function bindSetSetting(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): SettingsRuntimeOperations {
  return Object.freeze({
    setSetting: async (input: SetSettingInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.appBundleId,
        signal,
      });
      return await interactor.setSetting(
        input.setting,
        input.state,
        input.appBundleId,
        input.options,
      );
    },
  });
}
