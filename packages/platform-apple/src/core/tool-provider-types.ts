import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ScopedSimctlArgs } from '@agent-device/contracts/platform-runtime-host';
import { type ExecOptions, type ExecResult } from '@agent-device/host-kit/command';
import type { MacOsHostProvider } from '@agent-device/contracts/macos-platform-leaf';

/** Cleanup ignores scoped request cancellation but keeps explicit signals and its own deadline. */
export type AppleToolExecOptions = ExecOptions &
  ({ requestCancellation?: undefined } | { requestCancellation: 'ignore'; timeoutMs: number });

export type AppleToolCommandExecutor = (
  cmd: string,
  args: string[],
  options?: AppleToolExecOptions,
) => Promise<ExecResult>;

export type AppleToolSubcommandExecutor = (
  args: string[],
  options?: AppleToolExecOptions,
) => Promise<ExecResult>;

export type AppleToolAvailabilityChecker = (cmd: string) => Promise<boolean>;

export type AppleXcrunToolProvider = {
  run: AppleToolSubcommandExecutor;
};

export type AppleSimctlToolProvider = {
  run: (args: ScopedSimctlArgs, options?: AppleToolExecOptions) => Promise<ExecResult>;
};

export type AppleMacOsHelperProvider = {
  run: AppleToolSubcommandExecutor;
};

export type ApplePlistProvider = {
  readJson(path: string, signal?: AbortSignal): Promise<Record<string, unknown> | null>;
};

/**
 * The macOS host routes a request may substitute. A provider that names none leaves them to the
 * installed macOS leaf, which answers them with the local tools of this host.
 */
export type AppleMacOsHostProvider = MacOsHostProvider;

export type AppleSimulatorFileCopy = {
  device: DeviceInfo;
  bundleId: string;
  containerType: string;
  sourcePath: string;
  destinationPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type AppleSimulatorContainerRequest = {
  device: DeviceInfo;
  bundleId: string;
  containerType: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type AppleSimulatorContainer = {
  path?: string;
  list(): Promise<string[]>;
  remove(relativePath: string): Promise<void>;
  ensureDirectory(relativePath: string): Promise<void>;
};

export type SimulatorAppListOptions = Readonly<{
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type SimulatorAppMetadata = {
  bundleId: string;
  name: string;
  path?: string;
  applicationType?: string;
};

export type SimulatorAppListRead =
  | Readonly<{ type: 'listed'; apps: SimulatorAppMetadata[] }>
  | Readonly<{ type: 'unreadable'; exitCode: number | null | undefined; stderr: string }>;

export type AppleSimulatorAppInfoRequest = SimulatorAppListOptions & {
  device: DeviceInfo;
  bundleId: string;
  appPath?: string;
};
