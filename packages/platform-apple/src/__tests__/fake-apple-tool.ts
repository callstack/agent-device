import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AppleToolProvider } from '../core/tool-provider.ts';
import { withAppleToolProvider } from '../core/tool-provider.ts';
import { execFailureDetails, type ExecResult } from '@agent-device/host-kit/command';
import { IOS_DEVICE } from './device-fixtures.ts';

export type FakeAppleToolResponse = string | Partial<ExecResult> | Error;
export type FakeAppleToolScript = (args: string[]) => FakeAppleToolResponse | undefined;

export async function withFakeAppleTool<T>(
  script: FakeAppleToolScript,
  run: (ctx: { calls: string[][]; device: DeviceInfo }) => Promise<T>,
  options: { device?: DeviceInfo; provider?: Partial<AppleToolProvider> } = {},
): Promise<T> {
  const device: DeviceInfo = { ...(options.device ?? IOS_DEVICE) };
  const calls: string[][] = [];

  const respond = async (
    flat: string[],
    executable: string,
    allowFailure: boolean | undefined,
  ): Promise<ExecResult> => {
    calls.push([...flat]);
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
      await respond(cmd === 'xcrun' ? [...args] : [cmd, ...args], cmd, execOptions?.allowFailure),
    simctl: {
      run: async (args, execOptions) =>
        await respond(['simctl', ...args], 'xcrun', execOptions?.allowFailure),
    },
    devicectl: {
      run: async (args, execOptions) =>
        await respond(['devicectl', ...args], 'xcrun', execOptions?.allowFailure),
    },
  };

  return await withAppleToolProvider(provider, async () => await run({ calls, device }));
}
