import type { HARDWARE_BUTTON_NAME_LABELS, HardwareButton } from './device-rotation.ts';
import { requireInteractorMethod } from './interactor-operation-binding.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact, RuntimeOperationUnavailability } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * The system buttons: one press each, no arguments, nothing returned. `home` and `appSwitcher`
 * reach a springboard or recents surface; `actionButton` presses iPhone/iPad hardware;
 * the rest are the phone hardware keys the `hardware-button` command names — volume, power,
 * mute, the explicit sleep/wake events, and the media keys. What varies between them is which
 * owners carry the control, and that is the fact table's job, not a per-button module's: a
 * button joins this list and its owners state a cell.
 */
export const SYSTEM_BUTTONS = [
  'home',
  'appSwitcher',
  'actionButton',
  'volumeUp',
  'volumeDown',
  'power',
  'mute',
  'sleep',
  'wake',
  'mediaPlayPause',
  'mediaNext',
  'mediaPrevious',
  'mediaRewind',
  'mediaFastForward',
] as const;

export type SystemButton = (typeof SYSTEM_BUTTONS)[number];

/**
 * What the family names to a caller on a fail-closed refusal. The hardware keys read as the
 * positional names `hardware-button` takes.
 */
export const SYSTEM_BUTTON_LABELS = {
  home: 'home',
  appSwitcher: 'app-switcher',
  actionButton: 'action-button',
  volumeUp: 'volume-up',
  volumeDown: 'volume-down',
  power: 'power',
  mute: 'mute',
  sleep: 'sleep',
  wake: 'wake',
  mediaPlayPause: 'media-play-pause',
  mediaNext: 'media-next',
  mediaPrevious: 'media-previous',
  mediaRewind: 'media-rewind',
  mediaFastForward: 'media-fast-forward',
} as const satisfies Record<SystemButton, string>;

// The hardware-button command vocabulary in device-rotation.ts must stay a family sub-cell with
// these labels. device-rotation.ts cannot import this module — the type-only edge would close a
// contracts type cycle through the snapshot and interactor graphs (layering R9/R10) — so the pin
// runs here, on the label owner's side: a hardware button that is not a family cell, or a label
// rename that drifts from the command's positional names, fails to build. The contracts tests
// pin the lists are exhaustive in both directions at runtime.
// (A value-import of these literals from device-rotation.ts instead was measured and rejected:
// it made system-button-runtime.ts value-eager and joined 5 entry closures in
// scripts/__tests__/eager-closure-budgets.ts with no shared home to absorb it.)
type HardwareButtonsAreFamilyCells = HardwareButton extends SystemButton
  ? true
  : { drift: HardwareButton };
const hardwareButtonsAreFamilyCells: HardwareButtonsAreFamilyCells = true;
void hardwareButtonsAreFamilyCells;

type HardwareButtonLabelsMatchCommandNames = [
  typeof HARDWARE_BUTTON_NAME_LABELS,
  Pick<typeof SYSTEM_BUTTON_LABELS, HardwareButton>,
] extends [Pick<typeof SYSTEM_BUTTON_LABELS, HardwareButton>, typeof HARDWARE_BUTTON_NAME_LABELS]
  ? true
  : { drift: Pick<typeof SYSTEM_BUTTON_LABELS, HardwareButton> };
const hardwareButtonLabelsMatchCommandNames: HardwareButtonLabelsMatchCommandNames = true;
void hardwareButtonLabelsMatchCommandNames;

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
 * The Android `hardware-button` admission rule, shared by every owner that presses the phone
 * keys through `input keyevent` (the local adb runtime and the Limrun provider alike). A TV
 * target has no phone volume/power semantics and its own command family, so it refuses and
 * points at `tv-remote`; the synthetic `simulator` row has no device behind it.
 */
export interface AndroidHardwareButtonSubject {
  readonly kind: string;
  readonly target?: string;
}

// Frozen literals rather than unavailableFact(): that helper lives in platform-runtime.ts and a
// value import would add it to this module's eager closure, which the eager-closure budgets gate
// refuses for a contract with four eager modules at the merge-base.
const androidHardwareButtonTvUnavailable: RuntimeOperationUnavailability = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'hardware-button is not supported on Android TV targets; use tv-remote.',
});
const androidHardwareButtonKindUnavailable: RuntimeOperationUnavailability = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'hardware-button is supported on Android emulators and physical devices.',
});

const ANDROID_AVAILABLE = Object.freeze({ available: true } as const);

const ANDROID_HARDWARE_BUTTON_CELLS = SYSTEM_BUTTONS.filter(
  (button) => button !== 'home' && button !== 'appSwitcher' && button !== 'actionButton',
) satisfies readonly HardwareButton[];

type HardwareCellsCoverCommandVocabulary =
  HardwareButton extends (typeof ANDROID_HARDWARE_BUTTON_CELLS)[number]
    ? true
    : { missingFromCells: Exclude<HardwareButton, (typeof ANDROID_HARDWARE_BUTTON_CELLS)[number]> };
const hardwareCellsCoverCommandVocabulary: HardwareCellsCoverCommandVocabulary = true;
void hardwareCellsCoverCommandVocabulary;

/**
 * One device's verdict for every `hardware-button` cell. The local adb runtime and the Limrun
 * provider spread this over their family facts, so the phone/TV/simulator rule is stated once
 * for every key and a new key joins both owners with it.
 */
export function androidHardwareButtonFacts(
  device: AndroidHardwareButtonSubject,
): Readonly<Record<HardwareButton, RuntimeOperationFact>> {
  const availability = androidHardwareButtonAvailability(device);
  const facts: Partial<Record<HardwareButton, RuntimeOperationFact>> = {};
  for (const button of ANDROID_HARDWARE_BUTTON_CELLS) facts[button] = availability;
  return facts as Readonly<Record<HardwareButton, RuntimeOperationFact>>;
}

function androidHardwareButtonAvailability(
  device: AndroidHardwareButtonSubject,
): RuntimeOperationFact {
  if (device.kind === 'simulator') return androidHardwareButtonKindUnavailable;
  return device.target === 'tv' ? androidHardwareButtonTvUnavailable : ANDROID_AVAILABLE;
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
