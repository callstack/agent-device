import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { AppError, type AppErrorCode, type AppErrorDetails } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';

export type HostCommandResult = Readonly<{ stdout: string }>;

export type RunHostCommand = (
  command: string,
  args: readonly string[],
) => Promise<HostCommandResult>;

export type ProviderPluginHost = Readonly<{
  /** Host-supplied command environment. Include PATH, HOME and provider inputs when needed. */
  env: Readonly<Record<string, string | undefined>>;
  options: Readonly<Record<string, unknown>>;
  clientVersion: string;
  createError(code: AppErrorCode, message: string, details?: AppErrorDetails): AppError;
  /** Runs in the supplied host cwd/env; ambient process values are not added. */
  runHostCommand: RunHostCommand;
}>;

/**
 * The host a replay contribution's `setup` receives: version and error construction only. Replay
 * setup stays engine-free and reaches no command, environment, or options; the format backend's
 * lazy `create(host)` keeps the full replay backend host.
 */
export type ReplaySetupHost = Readonly<{
  clientVersion: string;
  createError(code: AppErrorCode, message: string, details?: AppErrorDetails): AppError;
}>;

export function createPluginHost(
  host: HostEnvironment,
  options: Record<string, unknown> | undefined,
  capabilities?: object,
): ProviderPluginHost {
  return Object.freeze({
    // The composing root's own additions, such as platform facets; this package names none.
    ...capabilities,
    env: Object.freeze({ ...host.env }),
    options: Object.freeze({ ...options }),
    clientVersion: readVersion(),
    createError: (code, message, details) => new AppError(code, message, details),
    runHostCommand: async (command, args) => {
      const { runCmd } = await import('@agent-device/host-kit/command');
      const { stdout } = await runCmd(command, [...args], {
        cwd: host.cwd,
        env: host.env,
        maxBuffer: 10 * 1024 * 1024,
        timeoutMs: 30_000,
      });
      return { stdout };
    },
  } satisfies ProviderPluginHost);
}

export function createReplaySetupHost(): ReplaySetupHost {
  return Object.freeze({
    clientVersion: readVersion(),
    createError: (code, message, details) => new AppError(code, message, details),
  } satisfies ReplaySetupHost);
}
