import type {
  BackendAlertAction,
  BackendAlertInfo,
  BackendAlertResult,
  BackendDeviceOrientation,
  BackendKeyboardResult,
  BackendTvRemoteOptions,
} from '../../../backend.ts';
import type { CommandContext } from '../../../runtime-contract.ts';
import type { BackMode } from '../../../contracts/back-mode.ts';
import { parseTvRemoteButton } from '../../../contracts/tv-remote.ts';
import { AppError } from '../../../kernel/errors.ts';
import { successText } from '../../../utils/success-text.ts';
import { requireIntInRange } from '../../../utils/validation.ts';
import { isKeyboardAction } from '../../../utils/keyboard-actions.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
  type BackendResultVariant,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import { toBackendContext } from '../../runtime-common.ts';
import { normalizeOptionalText } from '../../text.ts';

export type SystemBackCommandOptions = CommandContext & {
  mode?: BackMode;
};

export type SystemBackCommandResult = {
  kind: 'systemBack';
  mode: BackMode;
} & BackendResultEnvelope;

export type SystemHomeCommandOptions = CommandContext;

export type SystemHomeCommandResult = {
  kind: 'systemHome';
} & BackendResultEnvelope;

export type SystemOrientationCommandOptions = CommandContext & {
  orientation: BackendDeviceOrientation;
};

export type SystemOrientationCommandResult = {
  kind: 'systemOrientationSet';
  orientation: BackendDeviceOrientation;
} & BackendResultEnvelope;

/** @deprecated Renamed to {@link SystemOrientationCommandOptions}. Retained until the next major. */
export type SystemRotateCommandOptions = SystemOrientationCommandOptions;

/**
 * @deprecated Renamed to {@link SystemOrientationCommandResult}. This is the
 * legacy `kind: 'systemRotated'` contract, retained until the next major.
 */
export type SystemRotateCommandResult = {
  kind: 'systemRotated';
  orientation: BackendDeviceOrientation;
} & BackendResultEnvelope;

export type SystemKeyboardCommandOptions = CommandContext & {
  action?: 'status' | 'get' | 'dismiss' | 'enter' | 'return';
};

export type SystemKeyboardCommandResult =
  | BackendResultVariant<{
      kind: 'keyboardState';
      action: 'status' | 'get';
      state: BackendKeyboardResult;
    }>
  | BackendResultVariant<{
      kind: 'keyboardDismissed';
      action: 'dismiss';
      state: BackendKeyboardResult;
    }>
  | BackendResultVariant<{
      kind: 'keyboardEnterPressed';
      action: 'enter';
      state: BackendKeyboardResult;
    }>;

export type SystemClipboardCommandOptions =
  | (CommandContext & {
      action: 'read';
    })
  | (CommandContext & {
      action: 'write';
      text: string;
    });

export type SystemClipboardCommandResult =
  | {
      kind: 'clipboardText';
      action: 'read';
      text: string;
    }
  | BackendResultVariant<{
      kind: 'clipboardUpdated';
      action: 'write';
      textLength: number;
    }>;

export type SystemSettingsCommandOptions = CommandContext & {
  target?: string;
};

export type SystemSettingsCommandResult = {
  kind: 'settingsOpened';
  target?: string;
} & BackendResultEnvelope;

export type SystemAlertCommandOptions = CommandContext & {
  action?: BackendAlertAction;
  timeoutMs?: number;
};

export type SystemAlertCommandResult =
  | {
      kind: 'alertStatus';
      action: 'get';
      alert: BackendAlertInfo | null;
    }
  | BackendResultVariant<{
      kind: 'alertHandled';
      action: 'accept' | 'dismiss';
      handled: boolean;
      alert?: BackendAlertInfo;
      button?: string;
    }>
  | BackendResultVariant<{
      kind: 'alertWait';
      action: 'wait';
      alert: BackendAlertInfo | null;
      waitedMs?: number;
      timedOut?: boolean;
    }>;

export type SystemAppSwitcherCommandOptions = CommandContext;

export type SystemAppSwitcherCommandResult = {
  kind: 'appSwitcherOpened';
} & BackendResultEnvelope;

export type SystemTvRemoteCommandOptions = CommandContext & BackendTvRemoteOptions;

export type SystemTvRemoteCommandResult = {
  kind: 'tvRemotePressed';
  button: BackendTvRemoteOptions['button'];
  durationMs?: number;
} & BackendResultEnvelope;

export const backCommand: RuntimeCommand<
  SystemBackCommandOptions | undefined,
  SystemBackCommandResult
> = async (runtime, options = {}): Promise<SystemBackCommandResult> => {
  if (!runtime.backend.pressBack) {
    throw new AppError('UNSUPPORTED_OPERATION', 'system.back is not supported by this backend');
  }
  const mode = options.mode ?? 'in-app';
  if (mode !== 'in-app' && mode !== 'system') {
    throw new AppError('INVALID_ARGS', 'system.back mode must be in-app or system');
  }
  const backendResult = await runtime.backend.pressBack(toBackendContext(runtime, options), {
    mode,
  });
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'systemBack',
    mode,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText('Back'),
  };
};

export const homeCommand: RuntimeCommand<
  SystemHomeCommandOptions | undefined,
  SystemHomeCommandResult
> = async (runtime, options = {}): Promise<SystemHomeCommandResult> => {
  if (!runtime.backend.pressHome) {
    throw new AppError('UNSUPPORTED_OPERATION', 'system.home is not supported by this backend');
  }
  const backendResult = await runtime.backend.pressHome(toBackendContext(runtime, options));
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'systemHome',
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText('Home'),
  };
};

export const tvRemoteCommand: RuntimeCommand<
  SystemTvRemoteCommandOptions,
  SystemTvRemoteCommandResult
> = async (runtime, options): Promise<SystemTvRemoteCommandResult> => {
  if (!runtime.backend.pressTvRemote) {
    throw new AppError('UNSUPPORTED_OPERATION', 'system.tvRemote is not supported by this backend');
  }
  const button = parseTvRemoteButton(options.button);
  const durationMs =
    options.durationMs === undefined
      ? undefined
      : requireIntInRange(options.durationMs, 'durationMs', 0, 10_000);
  const backendResult = await runtime.backend.pressTvRemote(toBackendContext(runtime, options), {
    button,
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'tvRemotePressed',
    button,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(`Pressed TV remote ${button}`),
  };
};

export const orientationCommand: RuntimeCommand<
  SystemOrientationCommandOptions,
  SystemOrientationCommandResult
> = async (runtime, options): Promise<SystemOrientationCommandResult> => {
  if (!runtime.backend.setOrientation) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'system.orientation is not supported by this backend',
    );
  }
  const orientation = requireOrientation(options.orientation);
  const backendResult = await runtime.backend.setOrientation(
    toBackendContext(runtime, options),
    orientation,
  );
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'systemOrientationSet',
    orientation,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(`Rotated to ${orientation}`),
  };
};

/**
 * @deprecated Renamed to {@link orientationCommand}. Delegates to it and
 * restores the legacy `kind: 'systemRotated'` contract for existing consumers.
 * Retained until the next major version.
 */
export const rotateCommand: RuntimeCommand<
  SystemRotateCommandOptions,
  SystemRotateCommandResult
> = async (runtime, options): Promise<SystemRotateCommandResult> => {
  const result = await orientationCommand(runtime, options);
  return { ...result, kind: 'systemRotated' };
};

export const keyboardCommand: RuntimeCommand<
  SystemKeyboardCommandOptions | undefined,
  SystemKeyboardCommandResult
> = async (runtime, options = {}): Promise<SystemKeyboardCommandResult> => {
  if (!runtime.backend.setKeyboard) {
    throw new AppError('UNSUPPORTED_OPERATION', 'system.keyboard is not supported by this backend');
  }
  const action = options.action ?? 'status';
  if (!isKeyboardAction(action)) {
    throw new AppError(
      'INVALID_ARGS',
      'system.keyboard action must be status, get, dismiss, enter, or return',
    );
  }
  const state = await runtime.backend.setKeyboard(toBackendContext(runtime, options), { action });
  const formattedBackendResult = toBackendResult(state);
  const keyboardState = isKeyboardResult(state) ? state : {};
  if (action === 'enter' || action === 'return') {
    return normalizeKeyboardEnterResult(keyboardState, formattedBackendResult);
  }
  if (action === 'dismiss') {
    return normalizeKeyboardDismissResult(action, keyboardState, formattedBackendResult);
  }
  return normalizeKeyboardStateResult(action, keyboardState, formattedBackendResult);
};

export const clipboardCommand: RuntimeCommand<
  SystemClipboardCommandOptions,
  SystemClipboardCommandResult
> = async (runtime, options): Promise<SystemClipboardCommandResult> => {
  if (options.action === 'read') {
    if (!runtime.backend.getClipboard) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'system.clipboard read is not supported by this backend',
      );
    }
    const result = await runtime.backend.getClipboard(toBackendContext(runtime, options));
    return {
      kind: 'clipboardText',
      action: 'read',
      text: typeof result === 'string' ? result : result.text,
    };
  }

  if (options.action !== 'write') {
    throw new AppError('INVALID_ARGS', 'system.clipboard action must be read or write');
  }
  if (!runtime.backend.setClipboard) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'system.clipboard write is not supported by this backend',
    );
  }
  if (typeof options.text !== 'string') {
    throw new AppError('INVALID_ARGS', 'system.clipboard write requires text');
  }
  const backendResult = await runtime.backend.setClipboard(
    toBackendContext(runtime, options),
    options.text,
  );
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'clipboardUpdated',
    action: 'write',
    textLength: Array.from(options.text).length,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText('Clipboard updated'),
  };
};

export const settingsCommand: RuntimeCommand<
  SystemSettingsCommandOptions | undefined,
  SystemSettingsCommandResult
> = async (runtime, options = {}): Promise<SystemSettingsCommandResult> => {
  if (!runtime.backend.openSettings) {
    throw new AppError('UNSUPPORTED_OPERATION', 'system.settings is not supported by this backend');
  }
  const target = normalizeOptionalText(options.target, 'target');
  const backendResult = await runtime.backend.openSettings(
    toBackendContext(runtime, options),
    target,
  );
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'settingsOpened',
    ...(target ? { target } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(target ? `Opened settings: ${target}` : 'Opened settings'),
  };
};

export const alertCommand: RuntimeCommand<
  SystemAlertCommandOptions | undefined,
  SystemAlertCommandResult
> = async (runtime, options = {}): Promise<SystemAlertCommandResult> => {
  if (!runtime.backend.handleAlert) {
    throw new AppError('UNSUPPORTED_OPERATION', 'system.alert is not supported by this backend');
  }
  const action = options.action ?? 'get';
  if (action !== 'get' && action !== 'accept' && action !== 'dismiss' && action !== 'wait') {
    throw new AppError('INVALID_ARGS', 'system.alert action must be get, accept, dismiss, or wait');
  }
  const timeoutMs =
    options.timeoutMs === undefined
      ? undefined
      : requireIntInRange(options.timeoutMs, 'timeoutMs', 0, 120_000);
  const result = await runtime.backend.handleAlert(toBackendContext(runtime, options), action, {
    timeoutMs,
  });
  return normalizeAlertResult(action, result);
};

export const appSwitcherCommand: RuntimeCommand<
  SystemAppSwitcherCommandOptions | undefined,
  SystemAppSwitcherCommandResult
> = async (runtime, options = {}): Promise<SystemAppSwitcherCommandResult> => {
  if (!runtime.backend.openAppSwitcher) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'system.appSwitcher is not supported by this backend',
    );
  }
  const backendResult = await runtime.backend.openAppSwitcher(toBackendContext(runtime, options));
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'appSwitcherOpened',
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText('Opened app switcher'),
  };
};

function requireOrientation(orientation: BackendDeviceOrientation): BackendDeviceOrientation {
  switch (orientation) {
    case 'portrait':
    case 'portrait-upside-down':
    case 'landscape-left':
    case 'landscape-right':
      return orientation;
    default:
      throw new AppError(
        'INVALID_ARGS',
        'system.orientation must be portrait, portrait-upside-down, landscape-left, or landscape-right',
      );
  }
}

function normalizeAlertResult(
  action: BackendAlertAction,
  result: BackendAlertResult,
): SystemAlertCommandResult {
  if (action === 'get') {
    return normalizeAlertStatusResult(result);
  }
  if (action === 'wait') {
    return normalizeAlertWaitResult(result);
  }
  return normalizeAlertHandledResult(action, result);
}

function normalizeKeyboardEnterResult(
  state: BackendKeyboardResult,
  backendResult: Record<string, unknown> | undefined,
): SystemKeyboardCommandResult {
  return {
    kind: 'keyboardEnterPressed',
    action: 'enter',
    state,
    ...(backendResult ? { backendResult } : {}),
    ...successText('Keyboard enter pressed'),
  };
}

function normalizeKeyboardDismissResult(
  action: 'dismiss',
  state: BackendKeyboardResult,
  backendResult: Record<string, unknown> | undefined,
): SystemKeyboardCommandResult {
  return {
    kind: 'keyboardDismissed',
    action,
    state,
    ...(backendResult ? { backendResult } : {}),
    ...successText(state.dismissed === false ? 'Keyboard already hidden' : 'Keyboard dismissed'),
  };
}

function normalizeKeyboardStateResult(
  action: 'status' | 'get',
  state: BackendKeyboardResult,
  backendResult: Record<string, unknown> | undefined,
): SystemKeyboardCommandResult {
  return {
    kind: 'keyboardState',
    action,
    state,
    ...(backendResult ? { backendResult } : {}),
  };
}

function normalizeAlertStatusResult(result: BackendAlertResult): SystemAlertCommandResult {
  if (result.kind !== 'alertStatus') {
    throw new AppError('COMMAND_FAILED', 'system.alert get returned an invalid backend result');
  }
  return { kind: 'alertStatus', action: 'get', alert: result.alert };
}

function normalizeAlertWaitResult(result: BackendAlertResult): SystemAlertCommandResult {
  if (result.kind !== 'alertWait') {
    throw new AppError('COMMAND_FAILED', 'system.alert wait returned an invalid backend result');
  }
  return {
    kind: 'alertWait',
    action: 'wait',
    alert: result.alert,
    ...(result.waitedMs !== undefined ? { waitedMs: result.waitedMs } : {}),
    ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
    ...successText(result.alert ? 'Alert visible' : 'Alert wait timed out'),
  };
}

function normalizeAlertHandledResult(
  action: Exclude<BackendAlertAction, 'get' | 'wait'>,
  result: BackendAlertResult,
): SystemAlertCommandResult {
  if (result.kind !== 'alertHandled') {
    throw new AppError(
      'COMMAND_FAILED',
      `system.alert ${action} returned an invalid backend result`,
    );
  }
  return {
    kind: 'alertHandled',
    action,
    handled: result.handled,
    ...(result.alert ? { alert: result.alert } : {}),
    ...(result.button ? { button: result.button } : {}),
    ...successText(result.handled ? `Alert ${action}ed` : 'No alert handled'),
  };
}

function isKeyboardResult(value: unknown): value is BackendKeyboardResult {
  return Boolean(value && typeof value === 'object');
}
