import type { AgentDeviceRuntime } from '../../../runtime-contract.ts';
import { bindRuntimeCommands, type BoundOf, type RuntimeCommand } from '../../runtime-types.ts';
import { resolveAppsFilter } from '../app-inventory-contract.ts';
import {
  bootCommand,
  devicesCommand,
  installCommand,
  installFromSourceCommand,
  reinstallCommand,
  shutdownCommand,
  type AdminBootCommandOptions,
  type AdminBootCommandResult,
  type AdminDevicesCommandOptions,
  type AdminDevicesCommandResult,
  type AdminInstallCommandOptions,
  type AdminInstallCommandResult,
  type AdminInstallFromSourceCommandOptions,
  type AdminReinstallCommandOptions,
  type AdminShutdownCommandOptions,
  type AdminShutdownCommandResult,
} from './admin.ts';
import {
  closeAppCommand,
  getAppStateCommand,
  listAppsCommand,
  openAppCommand,
  pushAppCommand,
  triggerAppEventCommand,
  type CloseAppCommandOptions,
  type CloseAppCommandResult,
  type GetAppStateCommandOptions,
  type GetAppStateCommandResult,
  type ListAppsCommandOptions,
  type ListAppsCommandResult,
  type OpenAppCommandOptions,
  type OpenAppCommandResult,
  type PushAppCommandOptions,
  type PushAppCommandResult,
  type TriggerAppEventCommandOptions,
  type TriggerAppEventCommandResult,
} from './apps.ts';

export type AppCommands = {
  open: RuntimeCommand<OpenAppCommandOptions, OpenAppCommandResult>;
  close: RuntimeCommand<CloseAppCommandOptions | undefined, CloseAppCommandResult>;
  list: RuntimeCommand<ListAppsCommandOptions | undefined, ListAppsCommandResult>;
  state: RuntimeCommand<GetAppStateCommandOptions, GetAppStateCommandResult>;
  push: RuntimeCommand<PushAppCommandOptions, PushAppCommandResult>;
  triggerEvent: RuntimeCommand<TriggerAppEventCommandOptions, TriggerAppEventCommandResult>;
};

export type AdminCommands = {
  devices: RuntimeCommand<AdminDevicesCommandOptions | undefined, AdminDevicesCommandResult>;
  boot: RuntimeCommand<AdminBootCommandOptions | undefined, AdminBootCommandResult>;
  shutdown: RuntimeCommand<AdminShutdownCommandOptions | undefined, AdminShutdownCommandResult>;
  install: RuntimeCommand<AdminInstallCommandOptions, AdminInstallCommandResult>;
  reinstall: RuntimeCommand<AdminReinstallCommandOptions, AdminInstallCommandResult>;
  installFromSource: RuntimeCommand<
    AdminInstallFromSourceCommandOptions,
    AdminInstallCommandResult
  >;
};

export type BoundAppCommands = BoundOf<AppCommands>;

export type BoundAdminCommands = BoundOf<AdminCommands>;

export const appCommands: AppCommands = {
  open: openAppCommand,
  close: closeAppCommand,
  list: listAppsCommand,
  state: getAppStateCommand,
  push: pushAppCommand,
  triggerEvent: triggerAppEventCommand,
};

export const adminCommands: AdminCommands = {
  devices: devicesCommand,
  boot: bootCommand,
  shutdown: shutdownCommand,
  install: installCommand,
  reinstall: reinstallCommand,
  installFromSource: installFromSourceCommand,
};

export function bindAppCommands(runtime: AgentDeviceRuntime): BoundAppCommands {
  return {
    ...bindRuntimeCommands(appCommands, runtime),
    list: (options = {}) =>
      appCommands.list(runtime, {
        ...options,
        filter: resolveAppsFilter(options.filter),
      }),
  };
}
