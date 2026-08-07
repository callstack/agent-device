import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  withAndroidAdbProvider,
  type AndroidAdbExecutorResult,
} from '../../platforms/android/adb-executor.ts';
import { ANDROID_EMULATOR } from './device-fixtures.ts';

/**
 * A scripted response for one fake adb invocation: a string is shorthand for
 * that stdout with exit 0, a partial result overrides the success defaults,
 * an Error simulates a transport-level failure, and `undefined` falls back to
 * empty success (the same default the PATH-stub shell scripts expressed as
 * `exit 0`).
 */
export type FakeAdbResponse = string | Partial<AndroidAdbExecutorResult> | Error;

export type FakeAdbScript = (args: string[]) => FakeAdbResponse | undefined;

/**
 * Runs `run` with a scripted in-process adb provider installed through the
 * production {@link withAndroidAdbProvider} scope — the same seam the daemon
 * installs per request and the provider-scenario lane exercises. Prefer this
 * over `withMockedAdb`/`withScriptedAdb` (PATH-stub subprocesses): no PATH
 * mutation, no spawns, no real subprocess waits, so converted files can leave
 * the serialized `subprocess-stub` project and its contention-retry waiver.
 *
 * The fake `exec` receives device-scoped args without a leading
 * `-s <serial>`: scoped providers are per-device, and raw `runCmd('adb', …)`
 * calls inside the scope are intercepted with serial args stripped. Nonzero
 * `exitCode` responses flow through the production failure classification
 * (`coerceAdbResults`/failure hints), exactly like a real adb failure.
 */
export async function withFakeAdb<T>(
  script: FakeAdbScript,
  run: (ctx: { calls: string[][]; device: DeviceInfo }) => Promise<T>,
  options: { device?: DeviceInfo } = {},
): Promise<T> {
  // Fresh copy per call: tests may tailor the device without leaking
  // mutations into the shared fixture.
  const device: DeviceInfo = { ...(options.device ?? ANDROID_EMULATOR) };
  const calls: string[][] = [];
  const exec = async (args: string[]): Promise<AndroidAdbExecutorResult> => {
    calls.push([...args]);
    const response = script(args);
    if (response instanceof Error) throw response;
    if (typeof response === 'string') return { stdout: response, stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0, ...response };
  };
  return await withAndroidAdbProvider(
    { exec },
    { serial: device.id },
    async () => await run({ calls, device }),
  );
}
