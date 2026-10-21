import {
  actionButtonRuntimeUse,
  appSwitcherRuntimeUse,
  homeRuntimeUse,
  mediaFastForwardRuntimeUse,
  mediaNextRuntimeUse,
  mediaPlayPauseRuntimeUse,
  mediaPreviousRuntimeUse,
  mediaRewindRuntimeUse,
  muteRuntimeUse,
  powerRuntimeUse,
  sleepRuntimeUse,
  volumeDownRuntimeUse,
  volumeUpRuntimeUse,
  wakeRuntimeUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime, RuntimeUse } from '@agent-device/contracts/platform-runtime';
// The hardware-button vocabulary reads arrive through the contracts/device façade, whose
// device-rotation.ts section is the eager home for command positional vocabulary (#3848,
// eager-closure budgets); only the press-route types come from system-button-runtime.ts.
import {
  HARDWARE_BUTTON_NAME_LABELS,
  parseHardwareButtonPositionals,
  type HardwareButton,
} from '@agent-device/contracts/device';
import type {
  SystemButton,
  SystemButtonInput,
} from '@agent-device/contracts/system-button-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { successText } from '@agent-device/kernel/success-text';
import type { DaemonCommandContext } from '../core/context.ts';
import type { ResolvedGenericExecution } from '../core/generic-leaf-execution.ts';
import {
  resolveBoundGenericRuntime,
  type RuntimeAdmissionBindings,
} from '../core/runtime-admission.ts';
import { runtimeExecutionFromContext } from '../core/snapshot-runtime-capture-input.ts';

type SystemButtonUse = RuntimeUse<
  PlatformRuntimeOperations,
  readonly [SystemButton],
  readonly [],
  readonly []
>;

type SystemButtonCommandRow = Readonly<{
  /** The registry's declared use for the command: exactly one system-button cell. */
  use: SystemButtonUse;
  /** The success text the press reports; the response carries nothing else by design. */
  message: string;
}>;

/**
 * The generic-route commands that are one system-button press each (ADR 0019). A press has no
 * arguments, no settle and no observation payload: it is delivered to whatever the system routes
 * it to, and the response is the button's success text. One row per command is what keeps a new
 * button from growing a module, a dispatcher arm and a conformance entry of its own.
 */
const SYSTEM_BUTTON_COMMANDS = {
  home: { use: homeRuntimeUse, message: 'Home' },
  'app-switcher': { use: appSwitcherRuntimeUse, message: 'Opened app switcher' },
  'action-button': { use: actionButtonRuntimeUse, message: 'Pressed Action Button' },
} as const satisfies Record<string, SystemButtonCommandRow>;

export type SystemButtonCommand = keyof typeof SYSTEM_BUTTON_COMMANDS;

/**
 * Every generic-route command the shared press route below serves: the three argumentless presses
 * plus the positional-selected `hardware-button`, whose first positional names the cell (#3848).
 * The dispatcher's one guard covers the whole family, so a fourth button row grows this module's
 * table only — never the dispatcher's switch.
 */
export type SystemButtonRouteCommand = SystemButtonCommand | 'hardware-button';

export function isSystemButtonCommand(command: string): command is SystemButtonCommand {
  return Object.hasOwn(SYSTEM_BUTTON_COMMANDS, command);
}

export function isSystemButtonRouteCommand(command: string): command is SystemButtonRouteCommand {
  return command === 'hardware-button' || isSystemButtonCommand(command);
}

/**
 * The `hardware-button` command's positional-selected rows (ADR 0019 §9): the button names the
 * one family cell it presses, the way `keyboard <status|dismiss|enter>` names a keyboard cell.
 * One press, no settle and no observation payload — the same trait set `action-button` carries,
 * because the press goes to the system, not to the session app (#3848).
 */
const HARDWARE_BUTTON_COMMAND_ROWS = {
  // The row labels are derived from HARDWARE_BUTTON_NAME_LABELS, the same literals
  // SYSTEM_BUTTON_LABELS answers for; device-rotation.ts is already in this entry's eager
  // closure through the facade import above, so deriving them costs nothing (#3848).
  volumeUp: { use: volumeUpRuntimeUse, label: HARDWARE_BUTTON_NAME_LABELS.volumeUp },
  volumeDown: { use: volumeDownRuntimeUse, label: HARDWARE_BUTTON_NAME_LABELS.volumeDown },
  power: { use: powerRuntimeUse, label: HARDWARE_BUTTON_NAME_LABELS.power },
  mute: { use: muteRuntimeUse, label: HARDWARE_BUTTON_NAME_LABELS.mute },
  sleep: { use: sleepRuntimeUse, label: HARDWARE_BUTTON_NAME_LABELS.sleep },
  wake: { use: wakeRuntimeUse, label: HARDWARE_BUTTON_NAME_LABELS.wake },
  mediaPlayPause: {
    use: mediaPlayPauseRuntimeUse,
    label: HARDWARE_BUTTON_NAME_LABELS.mediaPlayPause,
  },
  mediaNext: { use: mediaNextRuntimeUse, label: HARDWARE_BUTTON_NAME_LABELS.mediaNext },
  mediaPrevious: {
    use: mediaPreviousRuntimeUse,
    label: HARDWARE_BUTTON_NAME_LABELS.mediaPrevious,
  },
  mediaRewind: { use: mediaRewindRuntimeUse, label: HARDWARE_BUTTON_NAME_LABELS.mediaRewind },
  mediaFastForward: {
    use: mediaFastForwardRuntimeUse,
    label: HARDWARE_BUTTON_NAME_LABELS.mediaFastForward,
  },
} as const satisfies Record<HardwareButton, Readonly<{ use: SystemButtonUse; label: string }>>;

/** The neutral intent one press carries, projected from a resolved command context. */
function systemButtonInput(context: DaemonCommandContext): SystemButtonInput {
  return {
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * The one place a system-button family command reaches a device. Admission inspects the exact
 * owner's cell for the button and binds once, before the dispatcher runs, so an owner without the
 * control is refused rather than discovered mid-execution. The `hardware-button` row delegates to
 * the positional-selected resolver below, which owns the button's arity and parse (#3848).
 */
export async function resolveBoundSystemButtonRuntime(
  command: SystemButtonRouteCommand,
  params: {
    device: DeviceInfo;
    /** Only `hardware-button` reads positionals; the argumentless presses ignore them. */
    positionals?: readonly string[];
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  if (command === 'hardware-button') {
    return await resolveBoundHardwareButtonRuntime({
      device: params.device,
      // The hardware resolver owns the positional default and the arity refusal; the delegate
      // forwards the request's optional positionals untouched.
      positionals: params.positionals,
      inspectFacts: params.inspectFacts,
      platformServices: params.platformServices,
      bindDevice: params.bindDevice,
    });
  }
  const row: SystemButtonCommandRow = SYSTEM_BUTTON_COMMANDS[command];
  return await resolveBoundGenericRuntime(
    {
      command,
      device: params.device,
      use: row.use,
      inspectFacts: params.inspectFacts,
      platformServices: params.platformServices,
      bindDevice: params.bindDevice,
    },
    async (runtime: BoundDeviceRuntime<SystemButtonUse>, context) => {
      const [button] = row.use.required;
      await runtime.operations[button](systemButtonInput(context));
      return { action: command, ...successText(row.message) };
    },
  );
}

/**
 * The one place `hardware-button` reaches a device (ADR 0019 §9). The positional picks the family
 * cell — one bind per request, never all three — and admission inspects the exact owner's cell for
 * that button before the dispatcher runs, so an owner without the key is refused rather than
 * discovered mid-execution. The result reports the dispatched press and nothing observed after it.
 */
export async function resolveBoundHardwareButtonRuntime(
  params: {
    device: DeviceInfo;
    /** Absent means no positional; the arity refusal below is what answers for it. */
    positionals?: readonly string[];
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  // Shared with the CLI reader: exactly one name, then the exact-name parse; an unknown name
  // refuses with INVALID_ARGS before any device dispatch.
  const button = parseHardwareButtonPositionals(params.positionals ?? []);
  const row = HARDWARE_BUTTON_COMMAND_ROWS[button];
  // Widen to the family use so one call site serves every row.
  const use: SystemButtonUse = row.use;
  return await resolveBoundGenericRuntime(
    {
      command: 'hardware-button',
      device: params.device,
      use,
      inspectFacts: params.inspectFacts,
      platformServices: params.platformServices,
      bindDevice: params.bindDevice,
    },
    async (runtime: BoundDeviceRuntime<SystemButtonUse>, context) => {
      const [operation] = row.use.required;
      await runtime.operations[operation](systemButtonInput(context));
      const name = row.label;
      return {
        action: 'hardware-button',
        button: name,
        ...successText(`Pressed hardware button ${name}`),
      };
    },
  );
}
