import type { BoundOf, RuntimeCommand } from '../../runtime-types.ts';
import {
  alertCommand,
  appSwitcherCommand,
  backCommand,
  clipboardCommand,
  homeCommand,
  keyboardCommand,
  orientationCommand,
  settingsCommand,
  tvRemoteCommand,
  type SystemAlertCommandOptions,
  type SystemAlertCommandResult,
  type SystemAppSwitcherCommandOptions,
  type SystemAppSwitcherCommandResult,
  type SystemBackCommandOptions,
  type SystemBackCommandResult,
  type SystemClipboardCommandOptions,
  type SystemClipboardCommandResult,
  type SystemHomeCommandOptions,
  type SystemHomeCommandResult,
  type SystemKeyboardCommandOptions,
  type SystemKeyboardCommandResult,
  type SystemOrientationCommandOptions,
  type SystemOrientationCommandResult,
  type SystemSettingsCommandOptions,
  type SystemSettingsCommandResult,
  type SystemTvRemoteCommandOptions,
  type SystemTvRemoteCommandResult,
} from './system.ts';

export type SystemCommands = {
  back: RuntimeCommand<SystemBackCommandOptions | undefined, SystemBackCommandResult>;
  home: RuntimeCommand<SystemHomeCommandOptions | undefined, SystemHomeCommandResult>;
  orientation: RuntimeCommand<SystemOrientationCommandOptions, SystemOrientationCommandResult>;
  keyboard: RuntimeCommand<SystemKeyboardCommandOptions | undefined, SystemKeyboardCommandResult>;
  clipboard: RuntimeCommand<SystemClipboardCommandOptions, SystemClipboardCommandResult>;
  settings: RuntimeCommand<SystemSettingsCommandOptions | undefined, SystemSettingsCommandResult>;
  alert: RuntimeCommand<SystemAlertCommandOptions | undefined, SystemAlertCommandResult>;
  appSwitcher: RuntimeCommand<
    SystemAppSwitcherCommandOptions | undefined,
    SystemAppSwitcherCommandResult
  >;
  tvRemote: RuntimeCommand<SystemTvRemoteCommandOptions, SystemTvRemoteCommandResult>;
};

export type BoundSystemCommands = BoundOf<SystemCommands>;

export const systemCommands: SystemCommands = {
  back: backCommand,
  home: homeCommand,
  orientation: orientationCommand,
  keyboard: keyboardCommand,
  clipboard: clipboardCommand,
  settings: settingsCommand,
  alert: alertCommand,
  appSwitcher: appSwitcherCommand,
  tvRemote: tvRemoteCommand,
};
