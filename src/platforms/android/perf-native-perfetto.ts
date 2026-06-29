import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
import { resolveAndroidAdbExecutor, type AndroidAdbExecutor } from './adb-executor.ts';
import {
  buildAndroidNativeRemotePath,
  cleanupAndroidRemotePath,
  stopAndroidNativePerfSession,
} from './perf-native-artifacts.ts';
import { annotateAndroidNativePerfError } from './perf-native-errors.ts';
import { resetAndroidFramePerfStats } from './perf-frame.ts';
import {
  assertAndroidNativeToolAvailable,
  findPidToken,
  resolveAndroidAppPid,
} from './perf-native-process.ts';
import {
  ANDROID_NATIVE_MAX_SECONDS,
  ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
  ANDROID_PERFETTO_METHOD,
  ANDROID_PERFETTO_REMOTE_DIR,
  type AndroidNativePerfOptions,
  type AndroidNativePerfSession,
  type AndroidNativePerfStartResult,
  type AndroidNativePerfStopResult,
} from './perf-native-types.ts';

export async function startAndroidPerfettoTrace(
  device: DeviceInfo,
  packageName: string,
  outPath: string,
  options: AndroidNativePerfOptions = {},
): Promise<AndroidNativePerfStartResult> {
  const adb = resolveAndroidAdbExecutor(device, options.adb);
  const appPid = await resolveAndroidAppPid(adb, packageName);
  await assertAndroidNativeToolAvailable(adb, 'perfetto', packageName);
  const remotePath = buildAndroidNativeRemotePath(
    packageName,
    'app.perfetto-trace',
    ANDROID_PERFETTO_REMOTE_DIR,
  );
  let profilerPid: string;
  try {
    await resetAndroidFramePerfStats(device, packageName, { adb });
    profilerPid = await startAndroidPerfettoBackgroundTool(adb, remotePath, packageName);
  } catch (error) {
    await cleanupAndroidRemotePath(adb, remotePath);
    throw error;
  }
  const session = {
    type: 'trace',
    kind: 'perfetto',
    packageName,
    appPid,
    profilerPid,
    remotePath,
    outPath,
    startedAt: Date.now(),
    state: 'running',
  } satisfies AndroidNativePerfSession;
  return {
    ...session,
    action: 'start',
    platform: 'android',
    method: ANDROID_PERFETTO_METHOD,
    message: `Started Android Perfetto trace for ${packageName}`,
  };
}

export async function stopAndroidPerfettoTrace(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
  outPath: string,
  options: AndroidNativePerfOptions = {},
): Promise<AndroidNativePerfStopResult> {
  return await stopAndroidNativePerfSession(device, { ...session, outPath }, options);
}

async function startAndroidPerfettoBackgroundTool(
  adb: AndroidAdbExecutor,
  remotePath: string,
  packageName: string,
): Promise<string> {
  try {
    const result = await adb(
      [
        'shell',
        'perfetto',
        '--background-wait',
        '-o',
        remotePath,
        '-t',
        `${ANDROID_NATIVE_MAX_SECONDS}s`,
        'sched',
        'freq',
        'idle',
        'am',
        'wm',
        'gfx',
        'view',
        'binder_driver',
        'hal',
        'dalvik',
      ],
      {
        timeoutMs: ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
      },
    );
    const pid = findPidToken(result.stdout);
    if (pid) return pid;
    throw new AppError('COMMAND_FAILED', 'Android perfetto did not return a profiler pid', {
      package: packageName,
      tool: 'perfetto',
      hint: 'Retry perf trace start. If perfetto exits immediately, verify the device permits trace capture.',
    });
  } catch (error) {
    throw annotateAndroidNativePerfError('start', 'perfetto', packageName, error);
  }
}
