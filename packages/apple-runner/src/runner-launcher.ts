import type { DeadlineClock } from '@agent-device/host-kit/retry';
import type { AppError } from '@agent-device/kernel/errors';
import type { IosRunnerDeviceStates } from './runner-error-classification.ts';
import type { LocalRunnerLaunchResources, RunnerDisposalOptions } from './runner-disposal.ts';
import type { RunnerEndpoint } from './runner-contract.ts';

/** A launched runner owns its output and settles both streams when terminated. */
export type RunnerLaunch = {
  exited: Promise<void>;
  output: AsyncIterable<string>;
  terminate(): Promise<void>;
};

/** Launch mechanisms supply resources; the session owner controls their lifetime. */
export type RunnerLauncher = {
  endpoint: Omit<RunnerEndpoint, 'token'>;
  launch(
    endpoint: RunnerEndpoint,
    signal: AbortSignal,
    deadline?: DeadlineClock,
  ): Promise<RunnerLaunch>;
};

export type RunnerLaunchObservation = {
  exited: boolean;
  failure?: unknown;
  finished: Promise<void>;
  output: Promise<void>;
  isRunning(): boolean;
  waitForExit(timeoutMs: number): Promise<boolean>;
  terminate(options?: RunnerDisposalOptions): Promise<void>;
  cleanup(options?: RunnerDisposalOptions): Promise<void>;
  readLogTail(maxBytes: number): string;
  earlyExitError(
    port: number,
    logPath?: string,
    deviceStates?: IosRunnerDeviceStates,
  ): Promise<AppError>;
  local?: LocalRunnerLaunchResources;
};
