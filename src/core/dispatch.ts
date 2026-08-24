import type { GesturePlan, Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import { emitDiagnostic, withDiagnosticTimer } from '../utils/diagnostics.ts';
import { readLocationCoordinate } from '../utils/location-coordinates.ts';
import { successText, withSuccessText } from '../utils/success-text.ts';
import { parseTriggerAppEventArgs, resolveAppEventUrl } from './app-events.ts';
import type { DescriptorDispatchCommandName } from './command-descriptor/registry.ts';
import type { DispatchContext } from './dispatch-context.ts';
import { handleScrollCommand } from './dispatch-scroll.ts';
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
  scroll: ({ interactor, positionals, context }) =>
    handleScrollCommand(interactor, positionals, context),
  'trigger-app-event': ({ device, interactor, positionals, context }) =>
    handleTriggerAppEventCommand(device, interactor, positionals, context),
  'app-switcher': async ({ interactor }) => {
    await interactor.appSwitcher();
    return { action: 'app-switcher', ...successText('Opened app switcher') };
  },
  clipboard: ({ interactor, positionals }) => handleClipboardCommand(interactor, positionals),
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
