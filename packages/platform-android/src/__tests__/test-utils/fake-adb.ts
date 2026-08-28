import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  androidAdbResultError,
  withAndroidAdbProvider,
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
  type AndroidAdbProvider,
} from '../../adb-executor.ts';
import { ANDROID_EMULATOR } from './device-fixtures.ts';
import { bindAndroidAdbTestHost } from './android-host-test-setup.ts';

export type FakeAdbResponse = string | Partial<AndroidAdbExecutorResult> | Error;
export type FakeAdbScript = (args: string[]) => FakeAdbResponse | undefined;

export type FakeAdbProviderExtras = AndroidAdbProvider extends infer P
  ? P extends AndroidAdbProvider
    ? Omit<P, 'exec'>
    : never
  : never;

export async function withFakeAdb<T>(
  script: FakeAdbScript,
  run: (ctx: { calls: string[][]; device: DeviceInfo }) => Promise<T>,
  options: {
    device?: DeviceInfo;
    provider?: FakeAdbProviderExtras;
  } = {},
): Promise<T> {
  const device: DeviceInfo = { ...(options.device ?? ANDROID_EMULATOR) };
  bindAndroidAdbTestHost();
  const calls: string[][] = [];
  const exec = async (
    args: string[],
    execOptions?: AndroidAdbExecutorOptions,
  ): Promise<AndroidAdbExecutorResult> => {
    calls.push([...args]);
    const response = script(args);
    if (response instanceof Error) throw response;
    const result: AndroidAdbExecutorResult =
      typeof response === 'string'
        ? { stdout: response, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0, ...response };
    if (result.exitCode !== 0 && !execOptions?.allowFailure) {
      throw androidAdbResultError(
        `adb ${args.join(' ')} exited with code ${result.exitCode}`,
        result,
      );
    }
    return result;
  };
  return await withAndroidAdbProvider(
    { ...options.provider, exec } as AndroidAdbProvider,
    { serial: device.id },
    async () => await run({ calls, device }),
  );
}
