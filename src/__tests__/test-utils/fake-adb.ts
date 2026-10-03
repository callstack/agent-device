import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  androidAdbResultError,
  withAndroidAdbProvider,
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
  type AndroidAdbProvider,
} from '@agent-device/platform-android/mechanics';
import { ANDROID_EMULATOR } from './device-fixtures.ts';
import '../../platform-runtime-android-adb-host.ts';

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
 * Extra provider capabilities for {@link withFakeAdb}. The conditional
 * distributes over the AndroidAdbProvider union so the touch capability
 * pairing survives: `touch` without `gestureViewport` stays a compile error
 * here instead of a TypeError inside production gesture planning.
 */
export type FakeAdbProviderExtras = AndroidAdbProvider extends infer P
  ? P extends AndroidAdbProvider
    ? Omit<P, 'exec'>
    : never
  : never;

/**
 * Runs `run` with a scripted in-process adb provider installed through the
 * production {@link withAndroidAdbProvider} scope — the same seam the daemon
 * installs per request and the provider-scenario lane exercises. Prefer this
 * over PATH-stub subprocess helpers (`withMockedAdb`): no PATH
 * mutation, no spawns, no real subprocess waits, so converted files do not need a
 * mutation exclusion in vitest.config.ts.
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
  options: {
    device?: DeviceInfo;
    /**
     * Extra provider capabilities (snapshotHelperArtifact, text, spawn, ...)
     * merged into the installed fake. `exec` always stays the scripted one so
     * `calls` keeps recording.
     */
    provider?: FakeAdbProviderExtras;
  } = {},
): Promise<T> {
  // Fresh copy per call: tests may tailor the device without leaking
  // mutations into the shared fixture.
  const device: DeviceInfo = { ...(options.device ?? ANDROID_EMULATOR) };
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
    // Mirror the local executor's contract: nonzero exit throws unless the
    // call site opted into allowFailure. Provider-scoped exec skips exec.ts's
    // throw-on-close-failure, so without this a scripted {exitCode: 1} would
    // sail through call sites that rely on the throw — a different production
    // path than the PATH-stub `exit 1` these fakes replaced.
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
