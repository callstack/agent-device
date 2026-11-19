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

export function createPluginHost(
  host: HostEnvironment,
  options: Record<string, unknown> | undefined,
): ProviderPluginHost {
  return Object.freeze({
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
