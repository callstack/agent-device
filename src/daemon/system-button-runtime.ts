import {
  actionButtonRuntimeUse,
  appSwitcherRuntimeUse,
  homeRuntimeUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime, RuntimeUse } from '@agent-device/contracts/platform-runtime';
import type {
  SystemButton,
  SystemButtonInput,
} from '@agent-device/contracts/system-button-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { successText } from '@agent-device/kernel/success-text';
import type { DaemonCommandContext } from './context.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

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

export function isSystemButtonCommand(command: string): command is SystemButtonCommand {
  return Object.hasOwn(SYSTEM_BUTTON_COMMANDS, command);
}

/** The neutral intent one press carries, projected from a resolved command context. */
function systemButtonInput(context: DaemonCommandContext): SystemButtonInput {
  return {
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * The one place a system-button command reaches a device. Admission inspects the exact owner's
 * cell for the button and binds once, before the dispatcher runs, so an owner without the control
 * is refused rather than discovered mid-execution.
 */
export async function resolveBoundSystemButtonRuntime(
  command: SystemButtonCommand,
  params: { device: DeviceInfo } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  const row: SystemButtonCommandRow = SYSTEM_BUTTON_COMMANDS[command];
  return await resolveBoundGenericRuntime(
    {
      command,
      device: params.device,
      use: row.use,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    },
    async (runtime: BoundDeviceRuntime<SystemButtonUse>, context) => {
      const [button] = row.use.required;
      await runtime.operations[button](systemButtonInput(context));
      return { action: command, ...successText(row.message) };
    },
  );
}
