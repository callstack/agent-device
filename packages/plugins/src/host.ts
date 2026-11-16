import { AppError, type AppErrorCode, type AppErrorDetails } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';
import { runCmd } from '@agent-device/host-kit/command';

export type HostCommandResult = Readonly<{ stdout: string }>;

export type RunHostCommand = (
  command: string,
  args: readonly string[],
) => Promise<HostCommandResult>;

export type ProviderPluginHost = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  options: Readonly<Record<string, unknown>>;
  clientVersion: string;
  createError(code: AppErrorCode, message: string, details?: AppErrorDetails): AppError;
  runHostCommand: RunHostCommand;
}>;

export function createPluginHost(
  env: NodeJS.ProcessEnv,
  options: Record<string, unknown> | undefined,
): ProviderPluginHost {
  return Object.freeze({
    env: Object.freeze({ ...env }),
    options: Object.freeze({ ...options }),
    clientVersion: readVersion(),
    createError: (code, message, details) => new AppError(code, message, details),
    runHostCommand: async (command, args) => {
      const { stdout } = await runCmd(command, [...args], {
        maxBuffer: 10 * 1024 * 1024,
        timeoutMs: 30_000,
      });
      return { stdout };
    },
  } satisfies ProviderPluginHost);
}
