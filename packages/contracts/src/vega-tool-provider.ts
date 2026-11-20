import type { VegaTvRemoteKey } from './tv-remote.ts';

/** One Vega CLI answer: what the tool printed and how it exited. */
export type VegaCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/** How one Vega CLI call runs. */
export type VegaCommandOptions = Readonly<{
  cwd?: string;
  allowFailure?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

/**
 * The Vega host-tool surface the Vega family scopes into a request: the Vega CLI adapter behind
 * inventory, doctor, app lifecycle and TV remote input. Root composition passes a resolved provider
 * back to the Vega plugin without naming its implementation.
 */
export type VegaToolProvider = Readonly<{
  isAvailable(): Promise<boolean>;
  version(options?: VegaCommandOptions): Promise<VegaCommandResult>;
  listDevices(options?: VegaCommandOptions): Promise<VegaCommandResult>;
  checkConnected(deviceId: string, options?: VegaCommandOptions): Promise<VegaCommandResult>;
  launchApp(
    deviceId: string,
    appName: string,
    options?: VegaCommandOptions,
  ): Promise<VegaCommandResult>;
  terminateApp(
    deviceId: string,
    appName: string,
    options?: VegaCommandOptions,
  ): Promise<VegaCommandResult>;
  pressRemote(
    deviceId: string,
    key: VegaTvRemoteKey,
    durationMs?: number,
    options?: VegaCommandOptions,
  ): Promise<VegaCommandResult>;
}>;
