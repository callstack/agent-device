import type {
  KeyboardActionInput,
  KeyboardDismissResult,
  KeyboardEnterResult,
  KeyboardStatusResult,
} from '@agent-device/contracts/keyboard-runtime';
import {
  keyboardDismissUse,
  keyboardEnterUse,
  keyboardStatusUse,
} from '@agent-device/contracts/platform-runtime-operations';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type {
  BoundDeviceRuntime,
  RuntimeOperationKey,
  RuntimeUse,
} from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isKeyboardAction, type KeyboardAction } from '../utils/keyboard-actions.ts';
import { successText } from '@agent-device/kernel/success-text';
import type { DaemonCommandContext } from './context.ts';
import {
  admitRuntimeUse,
  type RuntimeAdmissionBindings,
  type RuntimeAdmissionRequest,
} from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';
import type { DaemonFailureResponse } from './handlers/response.ts';

type KeyboardRuntimeAction = 'status' | 'dismiss' | 'enter';

/**
 * `keyboard`'s resolve/execute split (mirrors {@link ResolvedGenericExecution} from
 * `request-generic-dispatch.ts`), but scoped to what the session route actually has: a resolved
 * command context, never a full {@link SessionState} — `keyboard status`/`dismiss` run sessionless
 * through an explicit selector, so a handler that required one would be proving something false.
 */
export type ResolvedKeyboardExecution =
  | Readonly<{ ok: false; response: DaemonFailureResponse }>
  | Readonly<{
      ok: true;
      execute: (context: DaemonCommandContext) => Promise<Record<string, unknown> | void>;
    }>;

/** `keyboard <action>`, on the same parse the retired leaf used; `get`/`return` are aliases. */
function readKeyboardAction(positionals: readonly string[]): KeyboardRuntimeAction {
  const action = (positionals[0] ?? 'status').toLowerCase();
  if (!isKeyboardAction(action)) {
    throw new AppError(
      'INVALID_ARGS',
      'keyboard requires a subcommand: status, get, dismiss, enter, or return',
    );
  }
  if (positionals.length > 1) {
    throw new AppError('INVALID_ARGS', 'keyboard accepts at most one subcommand argument');
  }
  return normalizeKeyboardAction(action);
}

function normalizeKeyboardAction(action: KeyboardAction): KeyboardRuntimeAction {
  if (action === 'get') return 'status';
  if (action === 'return') return 'enter';
  return action;
}

/**
 * Every action's wire `platform` label is derived from which owner shape actually came back, not
 * re-derived from the device: each owner can only ever produce its own result `kind`, so these
 * mappings can't disagree with reality the way a separate device-platform guess could.
 */
const KEYBOARD_STATUS_PLATFORM_LABEL: Record<
  KeyboardStatusResult['kind'],
  'android' | 'harmonyos' | 'ios'
> = {
  'ime-probe': 'android',
};

const KEYBOARD_DISMISS_PLATFORM_LABEL: Record<
  KeyboardDismissResult['kind'],
  'android' | 'harmonyos' | 'ios'
> = {
  'ime-probe': 'android',
  mechanism: 'ios',
  acknowledged: 'harmonyos',
};

const KEYBOARD_ENTER_PLATFORM_LABEL: Record<
  KeyboardEnterResult['kind'],
  'android' | 'harmonyos' | 'ios'
> = {
  'visibility-echo': 'ios',
  'android-acknowledged': 'android',
  'harmonyos-acknowledged': 'harmonyos',
};

function keyboardActionInput(context: DaemonCommandContext): KeyboardActionInput {
  return {
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * The one place any of `keyboard`'s three action-selected uses admits and binds (R46): one
 * `admitRuntimeUse` call, deferred to the caller's `execute` closure exactly like
 * `resolveBoundGenericRuntime` does for the generic route — `runtime`'s type there is inferred
 * from the resolved `use` instantiation, never restated by hand. Kept local to this file rather
 * than folded into `resolveBoundGenericRuntime` itself: keyboard's execution shape
 * (`(context) => …`) is the session route's, not the generic dispatcher's
 * (`GenericPlatformExecution`) the other four leaves share.
 */
async function admitKeyboardAction<
  const Required extends readonly RuntimeOperationKey<PlatformRuntimeOperations>[],
  const Preferred extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number]
  >[],
  const Conditional extends readonly Exclude<
    RuntimeOperationKey<PlatformRuntimeOperations>,
    Required[number] | Preferred[number]
  >[],
>(
  request: Omit<RuntimeAdmissionRequest, 'required'> &
    Readonly<{ use: RuntimeUse<PlatformRuntimeOperations, Required, Preferred, Conditional> }>,
  execute: (
    runtime: BoundDeviceRuntime<
      RuntimeUse<PlatformRuntimeOperations, Required, Preferred, Conditional>
    >,
    context: DaemonCommandContext,
  ) => Promise<Record<string, unknown> | void>,
): Promise<ResolvedKeyboardExecution> {
  const admission = await admitRuntimeUse(request);
  if (admission.type === 'response') return { ok: false, response: admission.response };
  const runtime = admission.runtime;
  return { ok: true, execute: (context) => execute(runtime, context) };
}

/** `keyboard status` — Android-only; every other owner refuses. */
function executeKeyboardStatus(
  runtime: BoundDeviceRuntime<typeof keyboardStatusUse>,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  return runtime.operations.keyboardStatus(keyboardActionInput(context)).then((state) => ({
    platform: KEYBOARD_STATUS_PLATFORM_LABEL[state.kind],
    action: 'status',
    visible: state.visible,
    inputType: state.inputType,
    type: state.type,
    inputMethodPackage: state.inputMethodPackage,
    focusedPackage: state.focusedPackage,
    focusedResourceId: state.focusedResourceId,
    inputOwner: state.inputOwner,
  }));
}

/** `keyboard dismiss`. */
async function executeKeyboardDismiss(
  runtime: BoundDeviceRuntime<typeof keyboardDismissUse>,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  const result = await runtime.operations.keyboardDismiss(keyboardActionInput(context));
  const platform = KEYBOARD_DISMISS_PLATFORM_LABEL[result.kind];
  if (result.kind === 'mechanism') {
    return {
      platform,
      action: 'dismiss',
      wasVisible: result.wasVisible,
      dismissed: result.dismissed,
      visible: result.visible,
      mechanism: result.mechanism,
      ...successText(iosKeyboardDismissMessage(result.dismissed === true, result.mechanism)),
    };
  }
  if (result.kind === 'acknowledged') {
    return { platform, action: 'dismiss', ...successText('Keyboard dismissed') };
  }
  return {
    platform,
    action: 'dismiss',
    attempts: result.attempts,
    wasVisible: result.wasVisible,
    dismissed: result.dismissed,
    visible: result.visible,
    inputType: result.inputType,
    type: result.type,
    inputMethodPackage: result.inputMethodPackage,
    focusedPackage: result.focusedPackage,
    focusedResourceId: result.focusedResourceId,
    inputOwner: result.inputOwner,
  };
}

/** `keyboard enter`. */
async function executeKeyboardEnter(
  runtime: BoundDeviceRuntime<typeof keyboardEnterUse>,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  const result = await runtime.operations.keyboardEnter(keyboardActionInput(context));
  const platform = KEYBOARD_ENTER_PLATFORM_LABEL[result.kind];
  if (result.kind === 'visibility-echo') {
    return {
      platform,
      action: 'enter',
      visible: result.visible,
      wasVisible: result.wasVisible,
      ...successText('Keyboard enter pressed'),
    };
  }
  return { platform, action: 'enter', ...successText('Keyboard enter pressed') };
}

/**
 * The one place `keyboard` reaches a device (ADR 0019 §9). Exactly one action-selected use is
 * admitted and bound — `status`, `dismiss`, or `enter`, never all three — mirroring R35's find
 * closure: resolve one use per action, bind once.
 */
export async function resolveBoundKeyboardRuntime(
  params: {
    device: DeviceInfo;
  } & RuntimeAdmissionBindings & { positionals: readonly string[] },
): Promise<ResolvedKeyboardExecution> {
  const action = readKeyboardAction(params.positionals);
  const { device, inspectFacts, bindDevice } = params;
  if (action === 'status') {
    return await admitKeyboardAction(
      { command: 'keyboard status', device, use: keyboardStatusUse, inspectFacts, bindDevice },
      (runtime, context) => executeKeyboardStatus(runtime, context),
    );
  }
  if (action === 'dismiss') {
    return await admitKeyboardAction(
      { command: 'keyboard dismiss', device, use: keyboardDismissUse, inspectFacts, bindDevice },
      (runtime, context) => executeKeyboardDismiss(runtime, context),
    );
  }
  return await admitKeyboardAction(
    { command: 'keyboard enter', device, use: keyboardEnterUse, inspectFacts, bindDevice },
    (runtime, context) => executeKeyboardEnter(runtime, context),
  );
}

// Discloses which mechanism actually resigned the keyboard (#1598): a bare "dismissed" would
// leave the caller unable to tell a vouched-for control tap from app-side coincidence.
function iosKeyboardDismissMessage(dismissed: boolean, mechanism: string | undefined): string {
  if (!dismissed) return 'Keyboard already hidden';
  if (mechanism === 'dismissKey') {
    return 'Keyboard dismissed via its dismiss key';
  }
  return 'Keyboard dismissed';
}
