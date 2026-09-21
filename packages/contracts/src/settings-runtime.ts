import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { ReadSettingResult, SettingOptions } from './settings.ts';
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
 * Neutral intent for one settings read. It carries no `state` because a read asks for the value the
 * device holds rather than asserting one; `setting` is the same owner-keyed vocabulary the write
 * uses, so an owner serves both halves of a setting from one switch.
 */
export type ReadSettingInput = Readonly<{
  setting: string;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/**
 * Owners answer a write with their own settings payload or nothing at all, and a read with the
 * payload of the setting it serves; the daemon composes the response text around whichever it gets.
 */
export type SettingsRuntimeOperations = Readonly<{
  setSetting(input: SetSettingInput): Promise<Record<string, unknown> | void>;
  readSetting(input: ReadSettingInput): Promise<ReadSettingResult>;
}>;

export type SettingsRuntimeOperationFacts = Readonly<{
  setSetting: RuntimeOperationFact;
  readSetting: RuntimeOperationFact;
}>;

/**
 * Builds the exhaustive owner claims for the two settings operations. Both cells are stated, never
 * implied: a write and a read genuinely diverge for real owners — the macOS host sets an appearance
 * it has no ladder to read back, and the HarmonyOS leaf clears app state it cannot read — so an
 * owner that leaves one out is not compiled, not guessed.
 */
export function settingsRuntimeOperationFacts(
  input: Readonly<{
    setSetting: RuntimeOperationFact;
    readSetting: RuntimeOperationFact;
  }>,
): SettingsRuntimeOperationFacts {
  return Object.freeze({
    setSetting: input.setSetting,
    readSetting: input.readSetting,
  });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the setting named.
 */
async function resolveSettingsInteractor(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
  input: { execution?: SnapshotRuntimeExecution; appBundleId?: string },
): Promise<Interactor> {
  signal.throwIfAborted();
  return await resolveInteractor({
    ...input.execution,
    appBundleId: input.appBundleId,
    signal,
  });
}

export function bindSetSetting(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): Pick<SettingsRuntimeOperations, 'setSetting'> {
  return Object.freeze({
    setSetting: async (input: SetSettingInput) => {
      const interactor = await resolveSettingsInteractor(signal, resolveInteractor, input);
      return await interactor.setSetting(
        input.setting,
        input.state,
        input.appBundleId,
        input.options,
      );
    },
  });
}

/**
 * The read leg binds through the optional `readSetting` member, so an owner that never declares the
 * fact is refused at admission rather than resolving an absent method into an empty answer — the
 * same guard every optional-member binder takes.
 */
export function bindReadSetting(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): Pick<SettingsRuntimeOperations, 'readSetting'> {
  return Object.freeze({
    readSetting: async (input: ReadSettingInput) => {
      const interactor = await resolveSettingsInteractor(signal, resolveInteractor, input);
      // Loaded on the call rather than at module evaluation because this facade's eager closure is
      // held at its merge-base size (`eager-closure-budgets`); a static edge would grow it.
      const { requireInteractorMethod } = await import('./interactor-operation-binding.ts');
      const method = requireInteractorMethod(interactor.readSetting, 'settings read');
      return await method.call(interactor, input.setting);
    },
  });
}
