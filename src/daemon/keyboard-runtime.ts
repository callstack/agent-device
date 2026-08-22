import {
  keyboardDismissUse,
  keyboardEnterUse,
  keyboardStatusUse,
  type KeyboardActionInput,
  type KeyboardDismissResult,
  type KeyboardEnterResult,
  type KeyboardStatusResult,
} from '@agent-device/contracts/platform';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isKeyboardAction, type KeyboardAction } from '../utils/keyboard-actions.ts';
import { successText } from '../utils/success-text.ts';
import type { DaemonCommandContext } from './context.ts';
import { admitRuntimeUse, type RuntimeAdmissionBindings } from './runtime-admission.ts';
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

/** The literal the legacy leaf reported: `harmonyos`/`android` verbatim, every iOS-family OS as `ios`. */
function keyboardPlatformLabel(device: DeviceInfo): 'android' | 'harmonyos' | 'ios' {
  if (device.platform === 'harmonyos') return 'harmonyos';
  if (isIosFamily(device)) return 'ios';
  return 'android';
}

function keyboardActionInput(context: DaemonCommandContext): KeyboardActionInput {
  return {
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
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
  const platform = keyboardPlatformLabel(params.device);
  if (action === 'status') {
    const admission = await admitRuntimeUse({
      command: 'keyboard status',
      device: params.device,
      use: keyboardStatusUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
    if (admission.type === 'response') return { ok: false, response: admission.response };
    const runtime = admission.runtime;
    return {
      ok: true,
      execute: async (context) => await executeKeyboardStatus(runtime, platform, context),
    };
  }
  if (action === 'dismiss') {
    const admission = await admitRuntimeUse({
      command: 'keyboard dismiss',
      device: params.device,
      use: keyboardDismissUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
    if (admission.type === 'response') return { ok: false, response: admission.response };
    const runtime = admission.runtime;
    return {
      ok: true,
      execute: async (context) => await executeKeyboardDismiss(runtime, platform, context),
    };
  }
  const admission = await admitRuntimeUse({
    command: 'keyboard enter',
    device: params.device,
    use: keyboardEnterUse,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (admission.type === 'response') return { ok: false, response: admission.response };
  const runtime = admission.runtime;
  return {
    ok: true,
    execute: async (context) => await executeKeyboardEnter(runtime, platform, context),
  };
}

/** The ONE place a bound `keyboardStatus` executes (R46). Android-only; every other owner refuses. */
async function executeKeyboardStatus(
  runtime: Readonly<{
    operations: Readonly<{
      keyboardStatus: (input: KeyboardActionInput) => Promise<KeyboardStatusResult>;
    }>;
  }>,
  platform: 'android' | 'harmonyos' | 'ios',
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  const state = await runtime.operations.keyboardStatus(keyboardActionInput(context));
  return {
    platform,
    action: 'status',
    visible: state.visible,
    inputType: state.inputType,
    type: state.type,
    inputMethodPackage: state.inputMethodPackage,
    focusedPackage: state.focusedPackage,
    focusedResourceId: state.focusedResourceId,
    inputOwner: state.inputOwner,
  };
}

/** The ONE place a bound `keyboardDismiss` executes (R46). */
async function executeKeyboardDismiss(
  runtime: Readonly<{
    operations: Readonly<{
      keyboardDismiss: (input: KeyboardActionInput) => Promise<KeyboardDismissResult>;
    }>;
  }>,
  platform: 'android' | 'harmonyos' | 'ios',
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  const result = await runtime.operations.keyboardDismiss(keyboardActionInput(context));
  if (platform === 'ios') {
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
  if (platform === 'harmonyos') {
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

/** The ONE place a bound `keyboardEnter` executes (R46). */
async function executeKeyboardEnter(
  runtime: Readonly<{
    operations: Readonly<{
      keyboardEnter: (input: KeyboardActionInput) => Promise<KeyboardEnterResult>;
    }>;
  }>,
  platform: 'android' | 'harmonyos' | 'ios',
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  const result = await runtime.operations.keyboardEnter(keyboardActionInput(context));
  if (platform === 'ios') {
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

// Discloses which mechanism actually resigned the keyboard (#1598): a bare "dismissed" would
// leave the caller unable to tell a vouched-for control tap from app-side coincidence.
function iosKeyboardDismissMessage(dismissed: boolean, mechanism: string | undefined): string {
  if (!dismissed) return 'Keyboard already hidden';
  if (mechanism === 'dismissKey') {
    return 'Keyboard dismissed via its dismiss key';
  }
  return 'Keyboard dismissed';
}
