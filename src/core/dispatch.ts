import { promises as fs } from 'node:fs';
import pathModule from 'node:path';
import { AppError } from '../kernel/errors.ts';
import { isIosFamily, type DeviceInfo } from '../kernel/device.ts';
import { getInteractor } from './interactors.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import { isDeepLinkTarget } from '../contracts/open-target.ts';
import { parseTriggerAppEventArgs, resolveAppEventUrl } from './app-events.ts';
import {
  LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE,
  LAUNCH_CONSOLE_IOS_SIMULATOR_ONLY_MESSAGE,
} from '../contracts/launch-console.ts';
import { emitDiagnostic, withDiagnosticTimer } from '../utils/diagnostics.ts';
import { readLocationCoordinate } from '../utils/location-coordinates.ts';
import { successText, withSuccessText } from '../utils/success-text.ts';
import { requireIntInRange } from '../utils/validation.ts';
import { screenshotOptionsFromFlags } from '../contracts/screenshot.ts';
import { isKeyboardAction, type KeyboardAction } from '../utils/keyboard-actions.ts';
import type { DispatchContext } from './dispatch-context.ts';
import {
  handleFillCommand,
  handleFocusCommand,
  handleLongPressCommand,
  handlePressCommand,
  handleReadCommand,
  handleScrollCommand,
  handleTypeCommand,
} from './dispatch-interactions.ts';
import { readNotificationPayload } from './dispatch-payload.ts';
import { parseDeviceRotation } from '../contracts/device-rotation.ts';
import { parseTvRemoteButton } from '../contracts/tv-remote.ts';
import { readViewportDimension } from './viewport-dimension.ts';
import type { DescriptorDispatchCommandName } from './command-descriptor/registry.ts';
import type { GesturePlan } from '../contracts/gesture-plan-types.ts';
import type { Rect } from '../kernel/snapshot.ts';

export { resolveTargetDevice } from './dispatch-resolve.ts';
export type { CommandFlags, DispatchContext } from './dispatch-context.ts';

export async function dispatchCommand(
  device: DeviceInfo,
  command: string,
  positionals: string[],
  outPath?: string,
  context?: DispatchContext,
): Promise<Record<string, unknown> | void> {
  const runnerCtx = runnerContextFromDispatchContext(context);
  const interactor = await getInteractor(device, runnerCtx);
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
  open: ({ device, interactor, positionals, context }) =>
    handleOpenCommand(device, interactor, positionals, context),
  close: async ({ device, interactor, positionals }) => {
    const app = positionals[0];
    if (!app) {
      if (device.platform === 'web') {
        await interactor.close('');
      }
      return { closed: 'session', ...successText('Closed session') };
    }
    await interactor.close(app);
    return { app, ...successText(`Closed: ${app}`) };
  },
  press: ({ device, interactor, positionals, context }) =>
    handlePressCommand(device, interactor, positionals, context),
  longpress: ({ interactor, positionals }) => handleLongPressCommand(interactor, positionals),
  focus: ({ interactor, positionals }) => handleFocusCommand(interactor, positionals),
  type: ({ interactor, positionals, context }) =>
    handleTypeCommand(interactor, positionals, context),
  fill: ({ interactor, positionals, context }) =>
    handleFillCommand(interactor, positionals, context),
  scroll: ({ interactor, positionals, context }) =>
    handleScrollCommand(interactor, positionals, context),
  'trigger-app-event': ({ device, interactor, positionals, context }) =>
    handleTriggerAppEventCommand(device, interactor, positionals, context),
  screenshot: ({ interactor, positionals, outPath, context }) =>
    handleScreenshotCommand(interactor, positionals, outPath, context),
  viewport: ({ interactor, positionals }) => handleViewportCommand(interactor, positionals),
  back: async ({ interactor, context }) => {
    await interactor.back(context?.backMode);
    return { action: 'back', mode: context?.backMode ?? 'in-app', ...successText('Back') };
  },
  home: async ({ interactor }) => {
    await interactor.home();
    return { action: 'home', ...successText('Home') };
  },
  orientation: async ({ interactor, positionals }) => {
    const orientation = parseDeviceRotation(positionals[0]);
    await interactor.setOrientation(orientation);
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
  push: ({ device, positionals, context }) => handlePushCommand(device, positionals, context),
  snapshot: ({ interactor, context }) => handleSnapshotCommand(interactor, context),
  read: ({ device, positionals, context }) => handleReadCommand(device, positionals, context),
};

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

// fallow-ignore-next-line complexity
async function handleOpenCommand(
  device: DeviceInfo,
  interactor: Interactor,
  positionals: string[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const app = positionals[0];
  const url = positionals[1];
  const launchConsole = context?.launchConsole;
  const launchArgs = context?.launchArgs;
  if (positionals.length > 2) {
    throw new AppError('INVALID_ARGS', 'open accepts at most two arguments: <app|url> [url]');
  }
  if (!app) {
    if (launchConsole) {
      throw new AppError('INVALID_ARGS', '--launch-console requires an app target');
    }
    if (launchArgs && launchArgs.length > 0) {
      throw new AppError('INVALID_ARGS', '--launch-args requires an app target');
    }
    await interactor.openDevice();
    return { app: null, ...successText('Opened device') };
  }
  if (launchConsole && (!isIosFamily(device) || device.kind !== 'simulator')) {
    throw new AppError('UNSUPPORTED_OPERATION', LAUNCH_CONSOLE_IOS_SIMULATOR_ONLY_MESSAGE);
  }
  if (device.platform === 'linux' && launchArgs && launchArgs.length > 0) {
    throw new AppError('UNSUPPORTED_OPERATION', '--launch-args is not supported on Linux.');
  }
  if (url !== undefined) {
    if (isDeepLinkTarget(app)) {
      throw new AppError(
        'INVALID_ARGS',
        'open <app> <url> requires an app target as the first argument',
      );
    }
    if (!isDeepLinkTarget(url)) {
      throw new AppError('INVALID_ARGS', 'open <app> <url> requires a valid URL target');
    }
    if (launchConsole) {
      throw new AppError('INVALID_ARGS', LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE);
    }
    await interactor.open(app, {
      activity: context?.activity,
      appBundleId: context?.appBundleId,
      launchArgs,
      url,
    });
    return { app, url, ...successText(`Opened: ${app}`) };
  }
  if (launchConsole && isDeepLinkTarget(app)) {
    throw new AppError('INVALID_ARGS', LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE);
  }
  if (context?.clearAppState) {
    if (isDeepLinkTarget(app)) {
      throw new AppError(
        'INVALID_ARGS',
        'Clearing app state requires an app target, not a deep link.',
      );
    }
    await interactor.setSetting('clear-app-state', 'clear', app);
  }
  await interactor.open(app, {
    activity: context?.activity,
    appBundleId: context?.appBundleId,
    launchConsole,
    launchArgs,
    terminateRunningApp: context?.terminateRunningApp,
  });
  return { app, ...(launchConsole ? { launchConsole } : {}), ...successText(`Opened: ${app}`) };
}

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

async function handleScreenshotCommand(
  interactor: Interactor,
  positionals: string[],
  outPath: string | undefined,
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const positionalPath = positionals[0];
  const screenshotPath = positionalPath ?? outPath ?? `./screenshot-${Date.now()}.png`;
  await fs.mkdir(pathModule.dirname(screenshotPath), { recursive: true });
  const screenshotOptions = screenshotOptionsFromFlags(context);
  await interactor.screenshot(screenshotPath, {
    appBundleId: context?.appBundleId,
    pixelDensity: screenshotOptions.pixelDensity,
    fullscreen: screenshotOptions.fullscreen,
    normalizeStatusBar: screenshotOptions.normalizeStatusBar,
    stabilize: screenshotOptions.stabilize,
    surface: context?.surface,
    skipIosSimulatorBootCheck: context?.skipIosSimulatorBootCheck,
  });
  return { path: screenshotPath, ...successText(`Saved screenshot: ${screenshotPath}`) };
}

async function handleViewportCommand(
  interactor: Interactor,
  positionals: string[],
): Promise<Record<string, unknown>> {
  if (positionals.length !== 2) {
    throw new AppError('INVALID_ARGS', 'viewport requires exactly two arguments: <width> <height>');
  }
  const width = readViewportDimension(positionals[0], 'width');
  const height = readViewportDimension(positionals[1], 'height');
  if (!interactor.setViewport) {
    throw new AppError('UNSUPPORTED_OPERATION', 'viewport is not supported by this backend');
  }
  await interactor.setViewport(width, height);
  return { width, height, ...successText(`Viewport set: ${width}x${height}`) };
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
      hint: 'Select an Android TV or tvOS target with --target tv.',
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
  if (isIosFamily(device)) {
    return await handleIosKeyboardCommand(device, action, context, runnerCtx);
  }
  throw new AppError('UNSUPPORTED_OPERATION', 'keyboard is supported only on Android and iOS');
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
  return {
    platform: 'ios',
    action: 'dismiss',
    wasVisible: result.wasVisible,
    dismissed: result.dismissed,
    visible: result.visible,
    ...successText(result.dismissed ? 'Keyboard dismissed' : 'Keyboard already hidden'),
  };
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
      data: { setting, state: 'clear', appBundleId, platform: device.platform },
    });
    const result = await interactor.setSetting(setting, 'clear', appBundleId);
    return result && typeof result === 'object'
      ? withSuccessText(
          { setting, state: 'clear', ...result },
          readResultMessage(result) ?? `Cleared user data for ${appBundleId}`,
        )
      : { setting, state: 'clear', ...successText(`Cleared user data for ${appBundleId}`) };
  }
  if (!state) {
    throw new AppError('INVALID_ARGS', 'settings requires setting state');
  }
  const isLocationSet = setting === 'location' && state === 'set';
  const usesPayloadAppBundleSlot = setting === 'permission' || isLocationSet;
  const appBundleId =
    (usesPayloadAppBundleSlot ? positionals[4] : positionals[2]) ?? context?.appBundleId;
  const settingOptions =
    setting === 'permission'
      ? {
          permissionTarget: target,
          permissionMode: mode,
        }
      : isLocationSet
        ? {
            latitude: readLocationCoordinate(target, 'latitude'),
            longitude: readLocationCoordinate(mode, 'longitude'),
          }
        : undefined;
  const diagnosticPayload = isLocationSet
    ? { setting, state, latitude: target, longitude: mode, platform: device.platform }
    : setting === 'permission'
      ? {
          setting,
          state,
          permissionTarget: target,
          permissionMode: mode,
          platform: device.platform,
        }
      : { setting, state, appBundleId, platform: device.platform };
  emitDiagnostic({
    level: 'debug',
    phase: 'settings_apply',
    data: diagnosticPayload,
  });
  const result = await interactor.setSetting(setting, state, appBundleId, settingOptions);
  return result && typeof result === 'object'
    ? withSuccessText(
        { setting, state, ...result },
        readResultMessage(result) ?? `Updated setting: ${setting}`,
      )
    : { setting, state, ...successText(`Updated setting: ${setting}`) };
}

async function handlePushCommand(
  device: DeviceInfo,
  positionals: string[],
  _context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const target = positionals[0]?.trim();
  const payloadArg = positionals[1]?.trim();
  if (!target || !payloadArg) {
    throw new AppError('INVALID_ARGS', 'push requires <bundle|package> <payload.json|inline-json>');
  }
  const payload = await readNotificationPayload(payloadArg);
  if (isIosFamily(device)) {
    const { pushIosNotification } = await import('../platforms/apple/core/apps.ts');
    await pushIosNotification(device, target, payload);
    return {
      platform: 'ios',
      bundleId: target,
      ...successText(`Pushed notification to ${target}`),
    };
  }
  const { pushAndroidNotification } = await import('../platforms/android/notifications.ts');
  const androidResult = await pushAndroidNotification(device, target, payload);
  return {
    platform: 'android',
    package: target,
    action: androidResult.action,
    extrasCount: androidResult.extrasCount,
    ...successText(`Pushed notification to ${target}`),
  };
}

async function handleSnapshotCommand(
  interactor: Interactor,
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  return await interactor.snapshot({
    appBundleId: context?.appBundleId,
    interactiveOnly: context?.snapshotInteractiveOnly,
    depth: context?.snapshotDepth,
    scope: context?.snapshotScope,
    raw: context?.snapshotRaw,
    includeRects: context?.snapshotIncludeRects,
    surface: context?.surface,
  });
}

function readResultMessage(result: Record<string, unknown>): string | undefined {
  return typeof result.message === 'string' && result.message.length > 0
    ? result.message
    : undefined;
}
