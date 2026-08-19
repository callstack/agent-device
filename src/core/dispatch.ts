import { parseDeviceRotation } from '@agent-device/contracts/device';
import type { GesturePlan, Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import { parseTvRemoteButton } from '@agent-device/contracts/interaction';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import { emitDiagnostic, withDiagnosticTimer } from '../utils/diagnostics.ts';
import { isKeyboardAction, type KeyboardAction } from '../utils/keyboard-actions.ts';
import { readLocationCoordinate } from '../utils/location-coordinates.ts';
import { successText, withSuccessText } from '../utils/success-text.ts';
import { requireIntInRange } from '../utils/validation.ts';
import { parseTriggerAppEventArgs, resolveAppEventUrl } from './app-events.ts';
import type { DescriptorDispatchCommandName } from './command-descriptor/registry.ts';
import type { DispatchContext } from './dispatch-context.ts';
import {
  handleFillCommand,
  handleFocusCommand,
  handleHoverCommand,
  handleLongPressCommand,
  handlePressCommand,
  handleScrollCommand,
  handleTypeCommand,
} from './dispatch-interactions.ts';
import { getInteractor } from './interactors.ts';

export type { DispatchContext } from './dispatch-context.ts';
export { resolveTargetDevice } from './dispatch-resolve.ts';

export async function dispatchCommand(
  device: DeviceInfo,
  command: string,
  positionals: string[],
  outPath?: string,
  context?: DispatchContext,
): Promise<Record<string, unknown> | void> {
  const runnerCtx = runnerContextFromDispatchContext(context);
  const interactor = await getInteractor(device, runnerCtx);
  return await dispatchWithInteractor(
    device,
    interactor,
    command,
    positionals,
    outPath,
    context,
    runnerCtx,
  );
}

async function dispatchWithInteractor(
  device: DeviceInfo,
  interactor: Interactor,
  command: string,
  positionals: string[],
  outPath: string | undefined,
  context: DispatchContext | undefined,
  runnerCtx: RunnerContext,
): Promise<Record<string, unknown> | void> {
  emitDiagnostic({
    level: 'debug',
    phase: 'platform_command_prepare',
    data: {
      command,
      platform: device.platform,
      kind: device.kind,
    },
  });
  return await withDiagnosticTimer(
    'platform_command',
    async () => {
      return await dispatchKnownCommand(
        device,
        interactor,
        command,
        positionals,
        outPath,
        context,
        runnerCtx,
      );
    },
    {
      command,
      platform: device.platform,
    },
  );
}

export async function dispatchGesturePlan(
  device: DeviceInfo,
  plan: GesturePlan,
  context?: DispatchContext,
): Promise<Record<string, unknown> | void> {
  const interactor = await getInteractor(device, runnerContextFromDispatchContext(context));
  if (!interactor.performGesture) {
    throw new AppError('UNSUPPORTED_OPERATION', 'Gesture execution is unavailable');
  }
  return await interactor.performGesture(plan);
}

export async function dispatchGestureViewport(
  device: DeviceInfo,
  context?: DispatchContext,
): Promise<Rect | undefined> {
  const interactor = await getInteractor(device, runnerContextFromDispatchContext(context));
  return await interactor.gestureViewport?.();
}

function runnerContextFromDispatchContext(context?: DispatchContext): RunnerContext {
  return {
    requestId: context?.requestId,
    signal: context?.signal,
    appBundleId: context?.appBundleId,
    verbose: context?.verbose,
    logPath: context?.logPath,
    traceLogPath: context?.traceLogPath,
    iosXctestrunFile: context?.iosXctestrunFile,
    iosXctestDerivedDataPath: context?.iosXctestDerivedDataPath,
    iosXctestEnvDir: context?.iosXctestEnvDir,
    runnerLeaseContext: context?.runnerLeaseContext,
  };
}

type DispatchCommand = DescriptorDispatchCommandName;

type DispatchHandlerArgs = {
  device: DeviceInfo;
  interactor: Interactor;
  positionals: string[];
  outPath: string | undefined;
  context: DispatchContext | undefined;
  runnerCtx: RunnerContext;
};

type DispatchHandler = (args: DispatchHandlerArgs) => Promise<Record<string, unknown> | void>;

/**
 * Descriptor-driven exhaustive dispatch table. The `Record<DispatchCommand, …>`
 * type forces every descriptor-declared dispatch command to have a handler — a
 * missing entry is a COMPILE error, which replaces the former runtime `default:
 * throw` as the coverage safety net. Each entry routes to the IDENTICAL handler
 * with the IDENTICAL arguments the `switch` used, so dispatch stays strictly
 * behaviorless.
 */
const DISPATCH_HANDLERS: Record<DispatchCommand, DispatchHandler> = {
  press: ({ device, interactor, positionals, context }) =>
    handlePressCommand(device, interactor, positionals, context),
  longpress: ({ interactor, positionals }) => handleLongPressCommand(interactor, positionals),
  hover: ({ interactor, positionals }) => handleHoverCommand(interactor, positionals),
  focus: ({ interactor, positionals }) => handleFocusCommand(interactor, positionals),
  type: ({ interactor, positionals, context }) =>
    handleTypeCommand(interactor, positionals, context),
  fill: ({ interactor, positionals, context }) =>
    handleFillCommand(interactor, positionals, context),
  scroll: ({ interactor, positionals, context }) =>
    handleScrollCommand(interactor, positionals, context),
  'trigger-app-event': ({ device, interactor, positionals, context }) =>
    handleTriggerAppEventCommand(device, interactor, positionals, context),
  back: async ({ interactor, context }) => {
    await interactor.back(context?.backMode);
    return { action: 'back', mode: context?.backMode ?? 'in-app', ...successText('Back') };
  },
  home: async ({ interactor }) => {
    await interactor.home();
    return { action: 'home', ...successText('Home') };
  },
  orientation: async ({ interactor, positionals }) => {
    const requestedOrientation = parseDeviceRotation(positionals[0]);
    const result = await interactor.setOrientation(requestedOrientation);
    const orientation = result?.orientation ?? requestedOrientation;
    return { action: 'orientation', orientation, ...successText(`Rotated to ${orientation}`) };
  },
  'app-switcher': async ({ interactor }) => {
    await interactor.appSwitcher();
    return { action: 'app-switcher', ...successText('Opened app switcher') };
  },
  clipboard: ({ interactor, positionals }) => handleClipboardCommand(interactor, positionals),
  keyboard: ({ device, positionals, context, runnerCtx }) =>
    handleKeyboardCommand(device, positionals, context, runnerCtx),
  'tv-remote': ({ device, interactor, positionals, context }) =>
    handleTvRemoteCommand(device, interactor, positionals, context),
  settings: ({ device, interactor, positionals, context }) =>
    handleSettingsCommand(device, interactor, positionals, context),
};

/**
 * @internal Introspection helper used by parity tests.
 */
export function listRegisteredDispatchCommandNames(): string[] {
  return Object.keys(DISPATCH_HANDLERS).sort();
}

async function dispatchKnownCommand(
  device: DeviceInfo,
  interactor: Interactor,
  command: string,
  positionals: string[],
  outPath: string | undefined,
  context: DispatchContext | undefined,
  runnerCtx: RunnerContext,
): Promise<Record<string, unknown> | void> {
  // `Object.hasOwn` keeps the lookup behaviorless: any unknown command —
  // including inherited keys like `toString` — falls through to the same
  // `INVALID_ARGS` error the former `default:` branch threw.
  const handler = Object.hasOwn(DISPATCH_HANDLERS, command)
    ? DISPATCH_HANDLERS[command as DispatchCommand]
    : undefined;
  if (!handler) {
    throw new AppError('INVALID_ARGS', `Unknown command: ${command}`);
  }
  return await handler({ device, interactor, positionals, outPath, context, runnerCtx });
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleTriggerAppEventCommand(
  device: DeviceInfo,
  interactor: Interactor,
  positionals: string[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const { eventName, payload } = parseTriggerAppEventArgs(positionals);
  const eventUrl = resolveAppEventUrl(device, eventName, payload);
  await interactor.open(eventUrl, { appBundleId: context?.appBundleId });
  return {
    event: eventName,
    eventUrl,
    transport: 'deep-link',
    ...successText(`Triggered app event: ${eventName}`),
  };
}

async function handleClipboardCommand(
  interactor: Interactor,
  positionals: string[],
): Promise<Record<string, unknown>> {
  const action = (positionals[0] ?? '').toLowerCase();
  if (action !== 'read' && action !== 'write') {
    throw new AppError('INVALID_ARGS', 'clipboard requires a subcommand: read or write');
  }
  if (action === 'read') {
    if (positionals.length !== 1) {
      throw new AppError('INVALID_ARGS', 'clipboard read does not accept additional arguments');
    }
    const text = await interactor.readClipboard();
    return { action, text };
  }
  if (positionals.length < 2) {
    throw new AppError('INVALID_ARGS', 'clipboard write requires text (use "" to clear clipboard)');
  }
  const text = positionals.slice(1).join(' ');
  await interactor.writeClipboard(text);
  return {
    action,
    textLength: Array.from(text).length,
    ...successText('Clipboard updated'),
  };
}

async function handleTvRemoteCommand(
  device: DeviceInfo,
  interactor: Interactor,
  positionals: string[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  if (device.target !== 'tv') {
    throw new AppError('UNSUPPORTED_OPERATION', 'tv-remote is supported only on TV targets', {
      hint: 'Select an Android TV, tvOS, or Vega OS target with --target tv.',
    });
  }
  if (positionals.length !== 1) {
    throw new AppError('INVALID_ARGS', 'tv-remote requires exactly one button');
  }
  const button = parseTvRemoteButton(positionals[0]);
  const durationMs =
    context?.durationMs === undefined
      ? undefined
      : requireIntInRange(context.durationMs, 'durationMs', 0, 10_000);
  await interactor.tvRemote(button, durationMs);
  return {
    action: 'tv-remote',
    button,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...successText(`Pressed TV remote ${button}`),
  };
}

async function handleKeyboardCommand(
  device: DeviceInfo,
  positionals: string[],
  context: DispatchContext | undefined,
  runnerCtx: RunnerContext,
): Promise<Record<string, unknown>> {
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
  if (device.platform === 'android') {
    return await handleAndroidKeyboardCommand(device, action);
  }
  if (device.platform === 'harmonyos') {
    return await handleHarmonyKeyboardCommand(device, action);
  }
  if (isIosFamily(device)) {
    return await handleIosKeyboardCommand(device, action, context, runnerCtx);
  }
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'keyboard is supported only on Android, HarmonyOS, and iOS',
  );
}

async function handleHarmonyKeyboardCommand(
  device: DeviceInfo,
  action: KeyboardAction,
): Promise<Record<string, unknown>> {
  if (action !== 'dismiss' && action !== 'enter' && action !== 'return') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'keyboard status/get is not available through the public HarmonyOS HDC API; use keyboard dismiss or enter',
    );
  }
  const { pressHarmonyKeyboardKey } = await import('../platforms/harmonyos/input-actions.ts');
  const key = action === 'dismiss' ? 'Back' : 'Enter';
  await pressHarmonyKeyboardKey(device, key);
  return {
    platform: 'harmonyos',
    action: action === 'dismiss' ? 'dismiss' : 'enter',
    ...successText(action === 'dismiss' ? 'Keyboard dismissed' : 'Keyboard enter pressed'),
  };
}

async function handleAndroidKeyboardCommand(
  device: DeviceInfo,
  action: KeyboardAction,
): Promise<Record<string, unknown>> {
  if (action === 'enter' || action === 'return') {
    const { pressAndroidEnter } = await import('../platforms/android/input-actions.ts');
    await pressAndroidEnter(device);
    return {
      platform: 'android',
      action: 'enter',
      ...successText('Keyboard enter pressed'),
    };
  }
  if (action === 'dismiss') {
    const { dismissAndroidKeyboard } = await import('../platforms/android/device-input-state.ts');
    const result = await dismissAndroidKeyboard(device);
    return {
      platform: 'android',
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
  const { getAndroidKeyboardState } = await import('../platforms/android/device-input-state.ts');
  const state = await getAndroidKeyboardState(device);
  return {
    platform: 'android',
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

async function handleIosKeyboardCommand(
  device: DeviceInfo,
  action: KeyboardAction,
  context: DispatchContext | undefined,
  runnerCtx: RunnerContext,
): Promise<Record<string, unknown>> {
  if (action !== 'dismiss' && action !== 'enter' && action !== 'return') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'keyboard status/get is currently supported only on Android; use keyboard dismiss or enter on iOS',
    );
  }
  if (action === 'enter' || action === 'return') {
    const { runAppleRunnerCommand } =
      await import('../platforms/apple/core/runner/runner-client.ts');
    const result = await runAppleRunnerCommand(
      device,
      { command: 'keyboardReturn', appBundleId: context?.appBundleId },
      runnerCtx,
    );
    return {
      platform: 'ios',
      action: 'enter',
      visible: result.visible,
      wasVisible: result.wasVisible,
      ...successText('Keyboard enter pressed'),
    };
  }
  const { runAppleRunnerCommand } = await import('../platforms/apple/core/runner/runner-client.ts');
  const result = await runAppleRunnerCommand(
    device,
    { command: 'keyboardDismiss', appBundleId: context?.appBundleId },
    runnerCtx,
  );
  const mechanism =
    typeof result.keyboardDismissMechanism === 'string'
      ? result.keyboardDismissMechanism
      : undefined;
  return {
    platform: 'ios',
    action: 'dismiss',
    wasVisible: result.wasVisible,
    dismissed: result.dismissed,
    visible: result.visible,
    mechanism,
    ...successText(iosKeyboardDismissMessage(result.dismissed === true, mechanism)),
  };
}

// Discloses which mechanism actually resigned the keyboard (#1598): a
// Discloses that the keyboard's own dismiss key did the work (#1598); a bare
// "dismissed" would leave the caller unable to tell a vouched-for control tap
// from app-side coincidence.
function iosKeyboardDismissMessage(dismissed: boolean, mechanism: string | undefined): string {
  if (!dismissed) return 'Keyboard already hidden';
  if (mechanism === 'dismissKey') {
    return 'Keyboard dismissed via its dismiss key';
  }
  return 'Keyboard dismissed';
}

async function handleSettingsCommand(
  device: DeviceInfo,
  interactor: Interactor,
  positionals: string[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const [setting, state, target, mode] = positionals;
  if (!setting || (!state && setting !== 'clear-app-state')) {
    throw new AppError('INVALID_ARGS', 'settings requires setting state');
  }
  if (setting === 'clear-app-state') {
    return await handleClearAppStateSetting(device, interactor, state, target, context);
  }
  if (!state) {
    throw new AppError('INVALID_ARGS', 'settings requires setting state');
  }
  return await handleStandardSetting(
    device,
    interactor,
    setting,
    state,
    target,
    mode,
    positionals,
    context,
  );
}

async function handleClearAppStateSetting(
  device: DeviceInfo,
  interactor: Interactor,
  state: string | undefined,
  target: string | undefined,
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const appBundleId = (state === 'clear' ? target : state) ?? context?.appBundleId;
  if (!appBundleId) {
    throw new AppError(
      'INVALID_ARGS',
      'settings clear-app-state requires an app id or an active app session.',
    );
  }
  emitDiagnostic({
    level: 'debug',
    phase: 'settings_apply',
    data: { setting: 'clear-app-state', state: 'clear', appBundleId, platform: device.platform },
  });
  const result = await interactor.setSetting('clear-app-state', 'clear', appBundleId);
  return result && typeof result === 'object'
    ? withSuccessText(
        { setting: 'clear-app-state', state: 'clear', ...result },
        readResultMessage(result) ?? `Cleared user data for ${appBundleId}`,
      )
    : {
        setting: 'clear-app-state',
        state: 'clear',
        ...successText(`Cleared user data for ${appBundleId}`),
      };
}

async function handleStandardSetting(
  device: DeviceInfo,
  interactor: Interactor,
  setting: string,
  state: string,
  target: string | undefined,
  mode: string | undefined,
  positionals: string[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const isLocationSet = setting === 'location' && state === 'set';
  const usesPayloadAppBundleSlot = setting === 'permission' || isLocationSet;
  const appBundleId =
    (usesPayloadAppBundleSlot ? positionals[4] : positionals[2]) ?? context?.appBundleId;
  emitDiagnostic({
    level: 'debug',
    phase: 'settings_apply',
    data: buildSettingsDiagnosticPayload(
      device,
      setting,
      state,
      target,
      mode,
      appBundleId,
      isLocationSet,
    ),
  });
  const result = await interactor.setSetting(
    setting,
    state,
    appBundleId,
    buildSettingOptions(setting, target, mode, isLocationSet),
  );
  return result && typeof result === 'object'
    ? withSuccessText(
        { setting, state, ...result },
        readResultMessage(result) ?? `Updated setting: ${setting}`,
      )
    : { setting, state, ...successText(`Updated setting: ${setting}`) };
}

function buildSettingOptions(
  setting: string,
  target: string | undefined,
  mode: string | undefined,
  isLocationSet: boolean,
) {
  if (setting === 'permission') {
    return { permissionTarget: target, permissionMode: mode };
  }
  if (isLocationSet) {
    return {
      latitude: readLocationCoordinate(target, 'latitude'),
      longitude: readLocationCoordinate(mode, 'longitude'),
    };
  }
  return undefined;
}

function buildSettingsDiagnosticPayload(
  device: DeviceInfo,
  setting: string,
  state: string,
  target: string | undefined,
  mode: string | undefined,
  appBundleId: string | undefined,
  isLocationSet: boolean,
): Record<string, unknown> {
  if (isLocationSet) {
    return { setting, state, latitude: target, longitude: mode, platform: device.platform };
  }
  if (setting === 'permission') {
    return {
      setting,
      state,
      permissionTarget: target,
      permissionMode: mode,
      platform: device.platform,
    };
  }
  return { setting, state, appBundleId, platform: device.platform };
}

function readResultMessage(result: Record<string, unknown>): string | undefined {
  return typeof result.message === 'string' && result.message.length > 0
    ? result.message
    : undefined;
}
