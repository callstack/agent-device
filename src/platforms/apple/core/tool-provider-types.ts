import type { AppsFilter } from '@agent-device/contracts/device';
import { type ExecOptions, type ExecResult } from '@agent-device/host-kit/command';
import type { IosAppInfo } from './app-info.ts';

export type AppleToolCommandExecutor = (
  cmd: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export type AppleToolSubcommandExecutor = (
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export type AppleToolAvailabilityChecker = (cmd: string) => Promise<boolean>;

export type AppleXcrunToolProvider = {
  run: AppleToolSubcommandExecutor;
};

export type AppleMacOsHelperProvider = {
  run: AppleToolSubcommandExecutor;
};

export type ApplePlistProvider = {
  readJson(path: string, signal?: AbortSignal): Promise<Record<string, unknown> | null>;
};

export type AppleMacOsHostProvider = {
  openBundle(bundleId: string, url?: string): Promise<void>;
  openTarget(target: string): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  readDarkMode(): Promise<boolean>;
  setDarkMode(enabled: boolean): Promise<void>;
  listApps(filter: AppsFilter): Promise<IosAppInfo[]>;
};
