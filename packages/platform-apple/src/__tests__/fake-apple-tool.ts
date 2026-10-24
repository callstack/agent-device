import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AppleToolProvider } from '../core/tool-provider.ts';
import { withAppleToolProvider } from '../core/tool-provider.ts';
import {
  execFailureDetails,
  type ExecOptions,
  type ExecResult,
} from '@agent-device/host-kit/command';
import { IOS_DEVICE } from './device-fixtures.ts';

export type FakeAppleToolResponse = string | Partial<ExecResult> | Error;
export type FakeAppleToolScript = (args: string[]) => FakeAppleToolResponse | undefined;

export async function withFakeAppleTool<T>(
  script: FakeAppleToolScript,
  run: (ctx: {
    calls: string[][];
    /** One entry per call: the exec options the command boundary passed through. */
    execOptions: Array<{ env?: NodeJS.ProcessEnv; timeoutMs?: number }>;
    device: DeviceInfo;
  }) => Promise<T>,
  options: { device?: DeviceInfo; provider?: Partial<AppleToolProvider> } = {},
): Promise<T> {
  const device: DeviceInfo = { ...(options.device ?? IOS_DEVICE) };
  const calls: string[][] = [];
  const execOptions: Array<{ env?: NodeJS.ProcessEnv; timeoutMs?: number }> = [];

  const respond = async (
    flat: string[],
    executable: string,
    allowFailure: boolean | undefined,
    options?: ExecOptions,
  ): Promise<ExecResult> => {
    calls.push([...flat]);
    execOptions.push({ env: options?.env, timeoutMs: options?.timeoutMs });
    const response = script(flat);
    if (response instanceof Error) throw response;
    const result: ExecResult =
      typeof response === 'string'
        ? { stdout: response, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0, ...response };
    if (result.exitCode !== 0 && !allowFailure) {
      throw new AppError(
        'COMMAND_FAILED',
        `${executable} exited with code ${result.exitCode}`,
        execFailureDetails(result, { cmd: executable, args: flat }),
      );
    }
    return result;
  };

  const provider: AppleToolProvider = {
    ...options.provider,
    whichCommand: options.provider?.whichCommand ?? (async () => true),
    runCommand: async (cmd, args, execOptions) =>
      await respond(
        cmd === 'xcrun' ? [...args] : [cmd, ...args],
        cmd,
        execOptions?.allowFailure,
        execOptions,
      ),
    simctl: {
      run: async (args, execOptions) =>
        await respond(['simctl', ...args], 'xcrun', execOptions?.allowFailure, execOptions),
    },
    devicectl: {
      run: async (args, execOptions) =>
        await respond(['devicectl', ...args], 'xcrun', execOptions?.allowFailure, execOptions),
    },
  };

  return await withAppleToolProvider(
    provider,
    async () => await run({ calls, execOptions, device }),
  );
}
