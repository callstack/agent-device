import { requireInteractorMethod } from './interactor-operation-binding.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact, RuntimeOperationUnavailability } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';
import type { HardwareKey } from './tv-remote.ts';

/**
 * The system buttons: one press each, no arguments, nothing returned. `home` and `appSwitcher`
 * reach a springboard or recents surface; `actionButton` presses iPhone/iPad hardware. What
 * varies between them is which owners carry the control, and that is the fact table's job, not
 * a per-button module's: a button joins this list and its owners state a cell.
 *
 * `hardwareKey` is the family's one control that takes an argument: a single cell admits every
 * volume, power, and media key, because an owner either has a key-event channel or has none.
 */
export const SYSTEM_BUTTONS = ['home', 'appSwitcher', 'actionButton'] as const;

export type SystemButton = (typeof SYSTEM_BUTTONS)[number];

type SystemControl = SystemButton | 'hardwareKey';

const SYSTEM_CONTROLS = [
  ...SYSTEM_BUTTONS,
  'hardwareKey',
] as const satisfies readonly SystemControl[];

/** How a provider fail-closed refusal names each button to the caller. */
export const SYSTEM_BUTTON_LABELS = {
  home: 'home',
  appSwitcher: 'app-switcher',
  actionButton: 'action-button',
} as const satisfies Record<SystemButton, string>;

/** Neutral intent for one press: no arguments, so only runner metadata travels. */
export type SystemButtonInput = Readonly<{
  options?: Readonly<{ appBundleId?: string }>;
  /** Same runner metadata a capture needs; reuses that type rather than restating it. */
  execution?: SnapshotRuntimeExecution;
}>;

/** One hardware key press: the parsed key plus the same runner metadata a button carries. */
type HardwareKeyInput = SystemButtonInput & Readonly<{ key: HardwareKey }>;

/** A press returns nothing; every leaf discarded whatever the interactor answered. */
export type SystemButtonRuntimeOperations = Readonly<
  {
    [Button in SystemButton]: (input: SystemButtonInput) => Promise<void>;
  } & { hardwareKey: (input: HardwareKeyInput) => Promise<void> }
>;

export type SystemButtonRuntimeOperationFacts = Readonly<{
  [Control in SystemControl]: RuntimeOperationFact;
}>;

/**
 * What an owner declares about the system buttons. No button is one every owner carries, so
 * every cell is optional and `unsupported` names the denial an omitted cell reports: an owner
 * with no such control states that denial once instead of once per button, and a button added
 * to {@link SYSTEM_BUTTONS} is refused by every owner that has not named it.
 *
 * Omission is a classified denial, never an unclassified cell and never an implied success: the
 * type refuses a call that does not carry `unsupported`, so no owner can leave the family blank.
 * An owner that carries one button names it — omission means "refuses", never "the same as the
 * neighbour".
 */
export type SystemButtonRuntimeOperationFactsInput = Readonly<
  { unsupported: RuntimeOperationUnavailability } & {
    [Control in SystemControl]?: RuntimeOperationFact;
  }
>;

export function systemButtonRuntimeOperationFacts(
  input: SystemButtonRuntimeOperationFactsInput,
): SystemButtonRuntimeOperationFacts {
  const facts = {} as Record<SystemControl, RuntimeOperationFact>;
  for (const control of SYSTEM_CONTROLS) facts[control] = input[control] ?? input.unsupported;
  return Object.freeze(facts);
}

async function resolvePressInteractor(
  input: SystemButtonInput,
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): Promise<Interactor> {
  signal.throwIfAborted();
  return await resolveInteractor({
    ...input.execution,
    appBundleId: input.options?.appBundleId,
    signal,
  });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding and
 * presses one button through it. `Interactor` members for hardware only some owners carry are
 * optional; facts admit a button only for owners whose interactor implements it, so a missing
 * method at press time is a runtime-contract error, not a normal refusal.
 */
export function bindSystemButton<Button extends SystemButton>(
  button: Button,
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): Readonly<Pick<SystemButtonRuntimeOperations, Button>> {
  const press = async (input: SystemButtonInput): Promise<void> => {
    const interactor = await resolvePressInteractor(input, signal, resolveInteractor);
    await requireInteractorMethod(interactor[button], SYSTEM_BUTTON_LABELS[button]).call(
      interactor,
    );
  };
  return Object.freeze({ [button]: press }) as Readonly<
    Pick<SystemButtonRuntimeOperations, Button>
  >;
}

/** How a fail-closed refusal names the hardware key press to the caller, matching the command. */
export const HARDWARE_KEY_LABEL = 'hardware-key';

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding and
 * presses one hardware key through it, under the same fail-closed rule as {@link bindSystemButton}.
 */
export function bindHardwareKey(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): Readonly<Pick<SystemButtonRuntimeOperations, 'hardwareKey'>> {
  return Object.freeze({
    hardwareKey: async (input: HardwareKeyInput): Promise<void> => {
      const interactor = await resolvePressInteractor(input, signal, resolveInteractor);
      await requireInteractorMethod(interactor.hardwareKey, HARDWARE_KEY_LABEL).call(
        interactor,
        input.key,
      );
    },
  });
}
