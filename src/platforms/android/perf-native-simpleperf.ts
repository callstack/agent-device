import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
import { resolveAndroidAdbExecutor, type AndroidAdbExecutor } from './adb-executor.ts';
import {
  buildAndroidNativeRemotePath,
  cleanupAndroidRemotePath,
  readFileSize,
  shellQuote,
  stopAndroidNativePerfSession,
  writeJsonArtifact,
} from './perf-native-artifacts.ts';
import { annotateAndroidNativePerfError } from './perf-native-errors.ts';
import { parseSimpleperfReportEntries } from './perf-native-report.ts';
import {
  assertAndroidNativeToolAvailable,
  findPidToken,
  resolveAndroidAppPid,
} from './perf-native-process.ts';
import {
  ANDROID_NATIVE_MAX_SECONDS,
  ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
  ANDROID_NATIVE_REMOTE_DIR,
  ANDROID_SIMPLEPERF_METHOD,
  type AndroidNativePerfOptions,
  type AndroidNativePerfSession,
  type AndroidNativePerfStartResult,
  type AndroidNativePerfStopResult,
  type AndroidSimpleperfReportResult,
} from './perf-native-types.ts';

export async function startAndroidSimpleperfProfile(
  device: DeviceInfo,
  packageName: string,
  outPath: string,
  options: AndroidNativePerfOptions = {},
): Promise<AndroidNativePerfStartResult> {
  const adb = resolveAndroidAdbExecutor(device, options.adb);
  const appPid = await resolveAndroidAppPid(adb, packageName);
  await assertAndroidNativeToolAvailable(adb, 'simpleperf', packageName);
  const remotePath = buildAndroidNativeRemotePath(packageName, 'cpu.perf.data');
  let profilerPid: string;
  try {
    profilerPid = await startAndroidSimpleperfBackgroundTool(adb, appPid, remotePath, packageName);
  } catch (error) {
    await cleanupAndroidRemotePath(adb, remotePath);
    throw error;
  }
  const session = {
    type: 'cpu-profile',
    kind: 'simpleperf',
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
    method: ANDROID_SIMPLEPERF_METHOD,
    message: `Started Android Simpleperf CPU profile for ${packageName}`,
  };
}

export async function stopAndroidSimpleperfProfile(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
  outPath: string,
  options: AndroidNativePerfOptions = {},
): Promise<AndroidNativePerfStopResult> {
  return await stopAndroidNativePerfSession(device, { ...session, outPath }, options);
}

export async function writeAndroidSimpleperfReport(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
  outPath: string,
  options: AndroidNativePerfOptions = {},
): Promise<AndroidSimpleperfReportResult> {
  const adb = resolveAndroidAdbExecutor(device, options.adb);
  await assertAndroidNativeToolAvailable(adb, 'simpleperf', session.packageName);
  const report = await runAndroidSimpleperfReport(adb, session);
  const generatedAt = new Date().toISOString();
  const entries = parseSimpleperfReportEntries(report.stdout);
  const payload = {
    kind: 'simpleperf-report',
    generatedAt,
    packageName: session.packageName,
    appPid: session.appPid,
    sourceProfilePath: session.outPath,
    sourceRemotePath: session.remotePath,
    entryCount: entries.length,
    entries,
  };
  await writeJsonArtifact(outPath, payload);
  const sizeBytes = await readFileSize(outPath);
  return {
    action: 'report',
    platform: 'android',
    type: 'cpu-profile-report',
    kind: 'simpleperf',
    packageName: session.packageName,
    appPid: session.appPid,
    sourceProfilePath: session.outPath,
    outPath,
    sizeBytes,
    generatedAt,
    entryCount: entries.length,
    method: ANDROID_SIMPLEPERF_METHOD,
    message: `Wrote Android Simpleperf report for ${session.packageName}`,
  };
}

async function startAndroidSimpleperfBackgroundTool(
  adb: AndroidAdbExecutor,
  appPid: string,
  remotePath: string,
  packageName: string,
): Promise<string> {
  try {
    const result = await adb(['shell', buildSimpleperfStartCommand(appPid, remotePath)], {
      timeoutMs: ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
    });
    const pid = findPidToken(result.stdout);
    if (pid) return pid;
    throw new AppError('COMMAND_FAILED', 'Android simpleperf did not return a profiler pid', {
      package: packageName,
      tool: 'simpleperf',
      hint: 'Retry perf. If simpleperf exits immediately, verify the app is profileable and the device permits native profiling.',
    });
  } catch (error) {
    throw annotateAndroidNativePerfError('start', 'simpleperf', packageName, error);
  }
}

function buildSimpleperfStartCommand(appPid: string, remotePath: string): string {
  return buildBackgroundShellCommand(
    [
      'simpleperf',
      'record',
      '-e',
      'cpu-clock:u',
      '-p',
      appPid,
      '-o',
      remotePath,
      '--duration',
      String(ANDROID_NATIVE_MAX_SECONDS),
    ],
    'simpleperf',
  );
}

function buildBackgroundShellCommand(argv: string[], label: string): string {
  const command = argv.map(shellQuote).join(' ');
  const stderrPath = `${ANDROID_NATIVE_REMOTE_DIR}/agent-device-${label}-${Date.now()}.err`;
  return [
    `err=${shellQuote(stderrPath)}`,
    `(${command}) >/dev/null 2>"$err" & pid=$!`,
    'sleep 1',
    'if kill -0 "$pid" 2>/dev/null; then rm -f "$err"; echo "$pid"; exit 0; fi',
    'cat "$err" >&2',
    'rm -f "$err"',
    'exit 1',
  ].join('; ');
}

async function runAndroidSimpleperfReport(
  adb: AndroidAdbExecutor,
  session: AndroidNativePerfSession,
): Promise<{ stdout: string }> {
  try {
    return await adb(
      [
        'shell',
        'simpleperf',
        'report',
        '-i',
        session.remotePath,
        '--stdio',
        '--sort',
        'comm,dso,symbol',
      ],
      {
        timeoutMs: ANDROID_NATIVE_PROFILE_TIMEOUT_MS,
      },
    );
  } catch (error) {
    throw annotateAndroidNativePerfError('report', 'simpleperf', session.packageName, error);
  }
}
