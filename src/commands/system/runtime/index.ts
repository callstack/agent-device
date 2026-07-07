import type { AgentDeviceRuntime } from '../../../runtime-contract.ts';
import type { BoundRuntimeCommand, RuntimeCommand } from '../../runtime-types.ts';
import {
  alertCommand,
  appSwitcherCommand,
  backCommand,
  clipboardCommand,
  homeCommand,
  keyboardCommand,
  rotateCommand,
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
  type SystemRotateCommandOptions,
  type SystemRotateCommandResult,
  type SystemSettingsCommandOptions,
  type SystemSettingsCommandResult,
  type SystemTvRemoteCommandOptions,
  type SystemTvRemoteCommandResult,
} from './system.ts';

export type SystemCommands = {
  back: RuntimeCommand<SystemBackCommandOptions | undefined, SystemBackCommandResult>;
  home: RuntimeCommand<SystemHomeCommandOptions | undefined, SystemHomeCommandResult>;
  rotate: RuntimeCommand<SystemRotateCommandOptions, SystemRotateCommandResult>;
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

export type BoundSystemCommands = {
  back: (options?: SystemBackCommandOptions) => Promise<SystemBackCommandResult>;
  home: (options?: SystemHomeCommandOptions) => Promise<SystemHomeCommandResult>;
  rotate: BoundRuntimeCommand<SystemRotateCommandOptions, SystemRotateCommandResult>;
  keyboard: (options?: SystemKeyboardCommandOptions) => Promise<SystemKeyboardCommandResult>;
  clipboard: BoundRuntimeCommand<SystemClipboardCommandOptions, SystemClipboardCommandResult>;
  settings: (options?: SystemSettingsCommandOptions) => Promise<SystemSettingsCommandResult>;
  alert: (options?: SystemAlertCommandOptions) => Promise<SystemAlertCommandResult>;
  appSwitcher: (
    options?: SystemAppSwitcherCommandOptions,
  ) => Promise<SystemAppSwitcherCommandResult>;
  tvRemote: BoundRuntimeCommand<SystemTvRemoteCommandOptions, SystemTvRemoteCommandResult>;
};

export const systemCommands: SystemCommands = {
  back: backCommand,
  home: homeCommand,
  rotate: rotateCommand,
  keyboard: keyboardCommand,
  clipboard: clipboardCommand,
  settings: settingsCommand,
  alert: alertCommand,
  appSwitcher: appSwitcherCommand,
  tvRemote: tvRemoteCommand,
};

export function bindSystemCommands(runtime: AgentDeviceRuntime): BoundSystemCommands {
  return {
    back: (options) => systemCommands.back(runtime, options),
    home: (options) => systemCommands.home(runtime, options),
    rotate: (options) => systemCommands.rotate(runtime, options),
    keyboard: (options) => systemCommands.keyboard(runtime, options),
    clipboard: (options) => systemCommands.clipboard(runtime, options),
    settings: (options) => systemCommands.settings(runtime, options),
    alert: (options) => systemCommands.alert(runtime, options),
    appSwitcher: (options) => systemCommands.appSwitcher(runtime, options),
    tvRemote: (options) => systemCommands.tvRemote(runtime, options),
  };
}
