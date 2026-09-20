import { requireInteractorMethod } from './interactor-operation-binding.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact, RuntimeOperationUnavailability } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * The system buttons: one press each, no arguments, nothing returned. `home` and `appSwitcher`
 * reach a springboard or recents surface; `actionButton` presses iPhone/iPad hardware. What
 * varies between them is which owners carry the control, and that is the fact table's job, not
 * a per-button module's: a button joins this list and its owners state a cell.
 */
export const SYSTEM_BUTTONS = ['home', 'appSwitcher', 'actionButton'] as const;

export type SystemButton = (typeof SYSTEM_BUTTONS)[number];

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

/** A press returns nothing; every leaf discarded whatever the interactor answered. */
export type SystemButtonRuntimeOperations = Readonly<{
  [Button in SystemButton]: (input: SystemButtonInput) => Promise<void>;
}>;

export type SystemButtonRuntimeOperationFacts = Readonly<{
  [Button in SystemButton]: RuntimeOperationFact;
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
    [Button in SystemButton]?: RuntimeOperationFact;
  }
>;

export function systemButtonRuntimeOperationFacts(
  input: SystemButtonRuntimeOperationFactsInput,
): SystemButtonRuntimeOperationFacts {
  const facts = {} as Record<SystemButton, RuntimeOperationFact>;
  for (const button of SYSTEM_BUTTONS) facts[button] = input[button] ?? input.unsupported;
  return Object.freeze(facts);
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
    signal.throwIfAborted();
    const interactor = await resolveInteractor({
      ...input.execution,
      appBundleId: input.options?.appBundleId,
      signal,
    });
    await requireInteractorMethod(interactor[button], SYSTEM_BUTTON_LABELS[button]).call(
      interactor,
    );
  };
  return Object.freeze({ [button]: press }) as Readonly<
    Pick<SystemButtonRuntimeOperations, Button>
  >;
}
