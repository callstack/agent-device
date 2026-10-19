import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact, RuntimeOperationUnavailability } from './platform-runtime.ts';
import type { ReadSettingResult, SettingOptions } from './settings.ts';
import type { ReadableSetting, SettingName } from './settings-catalog.ts';
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
 * device holds rather than asserting one, and its `setting` is narrowed to the readable list: the leg
 * resolver only ever names a setting some owner answers, so an owner's read switch is exhaustive over
 * it rather than a default case that refuses.
 */
export type ReadSettingInput = Readonly<{
  setting: ReadableSetting;
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
 * Builds an owner's settings facts from the settings it serves. `target` gates every setting on the
 * device in hand; each listed setting may narrow it further, and a setting the owner does not list
 * answers with `unsupported`. An operation is available while any of its settings is; otherwise it
 * answers with its first listed setting's refusal, or `unsupported` when it lists none.
 */
export function settingsRuntimeOperationFacts(
  input: Readonly<{
    target: RuntimeOperationFact;
    unsupported: RuntimeOperationUnavailability;
    write: Readonly<Partial<Record<SettingName, RuntimeOperationFact>>>;
    read?: Readonly<Partial<Record<ReadableSetting, RuntimeOperationFact>>>;
  }>,
): SettingsRuntimeOperationFacts {
  return Object.freeze({
    setSetting: settingSubjectsFact(input, input.write),
    readSetting: settingSubjectsFact(input, input.read ?? {}),
  });
}

function settingSubjectsFact(
  owner: Readonly<{ target: RuntimeOperationFact; unsupported: RuntimeOperationUnavailability }>,
  served: Readonly<Partial<Record<SettingName, RuntimeOperationFact>>>,
): RuntimeOperationFact {
  if (!owner.target.available) return owner.target;
  const listed = Object.values(served).filter((fact) => fact !== undefined);
  if (!listed.some((fact) => fact.available)) return listed[0] ?? owner.unsupported;
  const subjects = Object.fromEntries(
    Object.entries(served).map(([name, fact]) => [name, fact.available ? AVAILABLE : fact]),
  );
  return Object.freeze({
    available: true,
    subjects: Object.freeze(subjects),
    unlisted: owner.unsupported,
  });
}

const AVAILABLE = Object.freeze({ available: true } as const);

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
