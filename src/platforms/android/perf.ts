import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
import { splitNonEmptyTrimmedLines } from '../../utils/parsing.ts';
import { resolveAndroidAdbExecutor, type AndroidAdbExecutor } from './adb-executor.ts';
import { parseNumericToken } from './perf-parsing.ts';
import { roundPercent } from '../perf-utils.ts';
export {
  ANDROID_FRAME_SAMPLE_DESCRIPTION,
  ANDROID_FRAME_SAMPLE_METHOD,
  parseAndroidFramePerfSample,
  resetAndroidFramePerfStats,
  sampleAndroidFramePerf,
  type AndroidFrameDropWindow,
  type AndroidFramePerfSample,
} from './perf-frame.ts';
export {
  cleanupAndroidNativePerfSession,
  startAndroidPerfettoTrace,
  startAndroidSimpleperfProfile,
  stopAndroidPerfettoTrace,
  stopAndroidSimpleperfProfile,
  writeAndroidSimpleperfReport,
  type AndroidNativePerfKind,
  type AndroidNativePerfSession,
  type AndroidNativePerfStartResult,
  type AndroidNativePerfStopResult,
  type AndroidNativePerfType,
  type AndroidSimpleperfReportResult,
} from './perf-native.ts';

export const ANDROID_CPU_SAMPLE_METHOD = 'adb-shell-dumpsys-cpuinfo';
export const ANDROID_CPU_SAMPLE_DESCRIPTION =
  'Aggregated CPU usage for app processes matched from adb shell dumpsys cpuinfo.';
export const ANDROID_MEMORY_SAMPLE_METHOD = 'adb-shell-dumpsys-meminfo';
export const ANDROID_MEMORY_SAMPLE_DESCRIPTION =
  'Memory snapshot from adb shell dumpsys meminfo <package>. Values are reported in kilobytes.';
export const ANDROID_HPROF_SNAPSHOT_METHOD = 'adb-shell-am-dumpheap';
export const ANDROID_HPROF_SNAPSHOT_DESCRIPTION =
  'Java heap dump captured with adb shell am dumpheap, pulled to a local artifact path.';

const ANDROID_PERF_TIMEOUT_MS = 15_000;
const ANDROID_HEAP_DUMP_TIMEOUT_MS = 120_000;
const ANDROID_REMOTE_HEAP_DIR = '/data/local/tmp';
const ANDROID_MEMORY_TOP_CONSUMER_LIMIT = 5;

export type AndroidPerfOptions = {
  adb?: AndroidAdbExecutor;
};

export type AndroidCpuPerfSample = {
  usagePercent: number;
  measuredAt: string;
  method: typeof ANDROID_CPU_SAMPLE_METHOD;
  matchedProcesses: string[];
};

export type AndroidMemoryPerfSample = {
  totalPssKb: number;
  totalRssKb?: number;
  measuredAt: string;
  method: typeof ANDROID_MEMORY_SAMPLE_METHOD;
  topConsumers?: AndroidMemoryConsumer[];
};

export type AndroidMemoryConsumer = {
  name: string;
  pssKb: number;
};

export type AndroidHeapSnapshotResult = {
  available: true;
  kind: 'android-hprof';
  path: string;
  sizeBytes: number;
  measuredAt: string;
  method: typeof ANDROID_HPROF_SNAPSHOT_METHOD;
  packageName: string;
  pid: number;
  remotePath: string;
};

export async function sampleAndroidCpuPerf(
  device: DeviceInfo,
  packageName: string,
  options: AndroidPerfOptions = {},
): Promise<AndroidCpuPerfSample> {
  const adb = resolveAndroidAdbExecutor(device, options.adb);
  try {
    const result = await adb(['shell', 'dumpsys', 'cpuinfo'], {
      timeoutMs: ANDROID_PERF_TIMEOUT_MS,
    });
    return parseAndroidCpuInfoSample(result.stdout, packageName, new Date().toISOString());
  } catch (error) {
    throw annotateAndroidPerfSamplingError('cpu', packageName, error);
  }
}

export async function sampleAndroidMemoryPerf(
  device: DeviceInfo,
  packageName: string,
  options: AndroidPerfOptions = {},
): Promise<AndroidMemoryPerfSample> {
  const adb = resolveAndroidAdbExecutor(device, options.adb);
  try {
    const result = await adb(['shell', 'dumpsys', 'meminfo', packageName], {
      timeoutMs: ANDROID_PERF_TIMEOUT_MS,
    });
    return parseAndroidMemInfoSample(result.stdout, packageName, new Date().toISOString());
  } catch (error) {
    throw annotateAndroidPerfSamplingError('memory', packageName, error);
  }
}

export async function captureAndroidHeapSnapshot(
  device: DeviceInfo,
  packageName: string,
  outPath: string,
  options: AndroidPerfOptions = {},
): Promise<AndroidHeapSnapshotResult> {
  const adb = resolveAndroidAdbExecutor(device, options.adb);
  const pid = await resolveAndroidAppPid(adb, packageName);
  const remotePath = buildAndroidRemoteHeapPath(packageName);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const hadLocalArtifact = await fileExists(outPath);
  try {
    const dumpResult = await adb(['shell', 'am', 'dumpheap', packageName, remotePath], {
      allowFailure: true,
      timeoutMs: ANDROID_HEAP_DUMP_TIMEOUT_MS,
    });
    if (dumpResult.exitCode !== 0) {
      throw new AppError(
        'COMMAND_FAILED',
        `Failed to capture Android heap dump for ${packageName}`,
        {
          kind: 'android-hprof',
          package: packageName,
          pid,
          remotePath,
          exitCode: dumpResult.exitCode,
          stdout: dumpResult.stdout,
          stderr: dumpResult.stderr,
          hint: resolveAndroidHeapDumpHint(dumpResult.stdout, dumpResult.stderr),
        },
      );
    }

    const pullResult = await adb(['pull', remotePath, outPath], {
      allowFailure: true,
      timeoutMs: ANDROID_HEAP_DUMP_TIMEOUT_MS,
    });
    if (pullResult.exitCode !== 0) {
      await cleanupLocalArtifact(outPath, hadLocalArtifact);
      throw new AppError('COMMAND_FAILED', `Failed to pull Android heap dump for ${packageName}`, {
        kind: 'android-hprof',
        package: packageName,
        pid,
        remotePath,
        path: outPath,
        exitCode: pullResult.exitCode,
        stdout: pullResult.stdout,
        stderr: pullResult.stderr,
        hint: 'Verify the daemon can write the requested --out path and retry. The heap dump stays on-device only until cleanup runs.',
      });
    }

    const stat = await fs.stat(outPath).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) {
      await cleanupLocalArtifact(outPath, hadLocalArtifact);
      throw new AppError('COMMAND_FAILED', `Android heap dump artifact is missing or empty`, {
        kind: 'android-hprof',
        package: packageName,
        pid,
        path: outPath,
        remotePath,
        hint: 'Retry with a writable --out path. If the file is still empty, inspect adb pull output with --debug.',
      });
    }

    return {
      available: true,
      kind: 'android-hprof',
      path: outPath,
      sizeBytes: stat.size,
      measuredAt: new Date().toISOString(),
      method: ANDROID_HPROF_SNAPSHOT_METHOD,
      packageName,
      pid,
      remotePath,
    };
  } finally {
    await adb(['shell', 'rm', '-f', remotePath], {
      allowFailure: true,
      timeoutMs: ANDROID_PERF_TIMEOUT_MS,
    }).catch(() => {});
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return await fs
    .stat(filePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

async function cleanupLocalArtifact(filePath: string, existedBefore: boolean): Promise<void> {
  if (existedBefore) return;
  await fs.rm(filePath, { force: true }).catch(() => {});
}

function parseAndroidCpuInfoSample(
  stdout: string,
  packageName: string,
  measuredAt: string,
): AndroidCpuPerfSample {
  const matchedProcesses = new Set<string>();
  let usagePercent = 0;

  for (const line of splitNonEmptyTrimmedLines(stdout)) {
    const match = line.match(/^([0-9]+(?:\.[0-9]+)?)%\s+\d+\/([^\s]+):\s/);
    if (!match) continue;

    const percentToken = match[1];
    const processName = match[2];
    if (percentToken === undefined || processName === undefined) continue;
    const percent = Number(percentToken);
    if (!Number.isFinite(percent) || !matchesAndroidPackageProcess(processName, packageName)) {
      continue;
    }

    usagePercent += percent;
    matchedProcesses.add(processName);
  }

  return {
    usagePercent: roundPercent(usagePercent),
    measuredAt,
    method: ANDROID_CPU_SAMPLE_METHOD,
    matchedProcesses: [...matchedProcesses],
  };
}

export function parseAndroidMemInfoSample(
  stdout: string,
  packageName: string,
  measuredAt: string,
): AndroidMemoryPerfSample {
  if (/no process found for:/i.test(stdout)) {
    throw new AppError(
      'COMMAND_FAILED',
      `Android meminfo did not find a running process for ${packageName}`,
      {
        metric: 'memory',
        package: packageName,
        hint: 'Run open <app> for this session again to ensure the Android app is active, then retry perf.',
      },
    );
  }

  const totalPssKb = matchLabeledNumber(stdout, 'TOTAL PSS') ?? matchTotalRowPss(stdout);
  if (totalPssKb === undefined) {
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to parse Android meminfo output for ${packageName}`,
      {
        metric: 'memory',
        package: packageName,
        hint: 'Retry perf after reopening the app session. If the problem persists, capture adb shell dumpsys meminfo output for debugging.',
      },
    );
  }

  return {
    totalPssKb,
    totalRssKb: matchLabeledNumber(stdout, 'TOTAL RSS'),
    measuredAt,
    method: ANDROID_MEMORY_SAMPLE_METHOD,
    topConsumers: parseAndroidMemInfoTopConsumers(stdout),
  };
}

async function resolveAndroidAppPid(adb: AndroidAdbExecutor, packageName: string): Promise<number> {
  const result = await adb(['shell', 'pidof', packageName], {
    allowFailure: true,
    timeoutMs: ANDROID_PERF_TIMEOUT_MS,
  });
  const pid = result.stdout
    .trim()
    .split(/\s+/)
    .map((token) => Number(token))
    .find((value) => Number.isInteger(value) && value > 0);
  if (result.exitCode === 0 && pid !== undefined) return pid;
  throw new AppError('COMMAND_FAILED', `No running Android process found for ${packageName}`, {
    kind: 'android-hprof',
    package: packageName,
    stdout: result.stdout,
    stderr: result.stderr,
    hint: 'Run open <app> for this session again to ensure the Android app is active, then retry perf memory snapshot.',
  });
}

function buildAndroidRemoteHeapPath(packageName: string): string {
  const safePackage = packageName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${ANDROID_REMOTE_HEAP_DIR}/agent-device-${safePackage}-${Date.now()}.hprof`;
}

function resolveAndroidHeapDumpHint(stdout: string, stderr: string): string {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (text.includes('profileable') || text.includes('debuggable') || text.includes('not allowed')) {
    return 'Android heap dumps require a debuggable/profileable app process on many devices. Use a debug/profileable build, reopen the app, then retry.';
  }
  if (text.includes('permission') || text.includes('denied')) {
    return 'The device denied heap dump access. Use a debug/profileable build or a device image that permits app heap dumping.';
  }
  return 'Reopen the app to refresh the process, then retry perf memory snapshot. If it still fails, run with --debug and inspect adb am dumpheap output.';
}

function parseAndroidMemInfoTopConsumers(stdout: string): AndroidMemoryConsumer[] | undefined {
  const consumers = stdout.split('\n').flatMap((line) => readAndroidMemInfoConsumer(line) ?? []);
  const topConsumers = consumers
    .sort((left, right) => right.pssKb - left.pssKb)
    .slice(0, ANDROID_MEMORY_TOP_CONSUMER_LIMIT);
  return topConsumers.length > 0 ? topConsumers : undefined;
}

function readAndroidMemInfoConsumer(rawLine: string): AndroidMemoryConsumer | undefined {
  const line = rawLine.trim();
  if (shouldSkipAndroidMemInfoConsumerLine(line)) return undefined;
  const match = line.match(/^(.+?)\s+([0-9][0-9,]*(?:\(\d+\))?)(?:\s|$)/);
  if (!match) return undefined;
  return buildAndroidMemInfoConsumer(match[1], match[2]);
}

function shouldSkipAndroidMemInfoConsumerLine(line: string): boolean {
  if (!line || line.startsWith('**') || line.startsWith('-') || line.includes(':')) return true;
  const looksLikeDataRow = /^\S.+\s+\d/.test(line);
  const isHeaderRow = /^(pss|total|native|dalvik|unknown|app summary\b)/i.test(line);
  return isHeaderRow && !looksLikeDataRow;
}

function buildAndroidMemInfoConsumer(
  rawName: string | undefined,
  rawPssKb: string | undefined,
): AndroidMemoryConsumer | undefined {
  const name = rawName?.trim();
  const pssKb = rawPssKb ? parseNumericToken(rawPssKb) : null;
  if (!name || name === 'TOTAL' || pssKb === null || pssKb <= 0) return undefined;
  if (/^(pss|private|shared|heap|size|alloc|free)$/i.test(name)) return undefined;
  return { name, pssKb };
}

function annotateAndroidPerfSamplingError(
  metric: 'cpu' | 'memory',
  packageName: string,
  error: unknown,
): AppError {
  if (error instanceof AppError) {
    return new AppError(
      error.code,
      error.message,
      {
        ...(error.details ?? {}),
        metric,
        package: packageName,
      },
      error,
    );
  }

  return new AppError(
    'COMMAND_FAILED',
    `Failed to sample Android ${metric} for ${packageName}`,
    {
      metric,
      package: packageName,
    },
    error,
  );
}

function matchesAndroidPackageProcess(processName: string, packageName: string): boolean {
  return processName === packageName || processName.startsWith(`${packageName}:`);
}

function matchLabeledNumber(text: string, label: string): number | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escapedLabel}:\\s*([0-9][0-9,]*)`, 'i'));
  if (!match) return undefined;
  const token = match[1];
  return token === undefined ? undefined : (parseNumericToken(token) ?? undefined);
}

function matchTotalRowPss(text: string): number | undefined {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    // Skip the "TOTAL PSS:" summary line and only match the tabular TOTAL row.
    if (!/^TOTAL\b(?!\s+PSS:)/.test(line)) continue;
    const firstValue = line
      .split(/\s+/)
      .slice(1)
      .find((token) => parseNumericToken(token) !== null);
    if (!firstValue) return undefined;
    return parseNumericToken(firstValue) ?? undefined;
  }
  return undefined;
}
