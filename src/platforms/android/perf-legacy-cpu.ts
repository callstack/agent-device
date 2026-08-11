import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { splitNonEmptyTrimmedLines } from '../../utils/parsing.ts';
import { resolveAndroidAdbExecutor, type AndroidAdbExecutor } from './adb-executor.ts';
import { roundPercent } from '../perf-utils.ts';

export const ANDROID_LEGACY_CPU_SAMPLE_METHOD = 'adb-shell-dumpsys-cpuinfo';
export const ANDROID_LEGACY_CPU_SAMPLE_DESCRIPTION =
  'Aggregated CPU usage for app processes matched from adb shell dumpsys cpuinfo.';

const ANDROID_LEGACY_CPU_TIMEOUT_MS = 15_000;

export type AndroidLegacyCpuPerfSample = {
  usagePercent: number;
  measuredAt: string;
  method: typeof ANDROID_LEGACY_CPU_SAMPLE_METHOD;
  matchedProcesses: string[];
};

/** Retained only for the released aggregate perf compatibility route until the next major. */
export async function sampleLegacyAndroidCpuPerf(
  device: DeviceInfo,
  packageName: string,
  options: { adb?: AndroidAdbExecutor } = {},
): Promise<AndroidLegacyCpuPerfSample> {
  const adb = resolveAndroidAdbExecutor(device, options.adb);
  try {
    const result = await adb(['shell', 'dumpsys', 'cpuinfo'], {
      timeoutMs: ANDROID_LEGACY_CPU_TIMEOUT_MS,
    });
    return parseLegacyAndroidCpuInfo(result.stdout, packageName, new Date().toISOString());
  } catch (error) {
    throw annotateLegacyAndroidCpuError(packageName, error);
  }
}

function parseLegacyAndroidCpuInfo(
  stdout: string,
  packageName: string,
  measuredAt: string,
): AndroidLegacyCpuPerfSample {
  const matchedProcesses = new Set<string>();
  let usagePercent = 0;
  for (const line of splitNonEmptyTrimmedLines(stdout)) {
    const processUsage = readPackageProcessUsage(line, packageName);
    if (!processUsage) continue;
    usagePercent += processUsage.percent;
    matchedProcesses.add(processUsage.processName);
  }
  return {
    usagePercent: roundPercent(usagePercent),
    measuredAt,
    method: ANDROID_LEGACY_CPU_SAMPLE_METHOD,
    matchedProcesses: [...matchedProcesses],
  };
}

function readPackageProcessUsage(
  line: string,
  packageName: string,
): { percent: number; processName: string } | undefined {
  const match = line.match(/^([0-9]+(?:\.[0-9]+)?)%\s+\d+\/([^\s]+):\s/);
  const percent = Number(match?.[1]);
  const processName = match?.[2];
  if (
    !processName ||
    !Number.isFinite(percent) ||
    !matchesPackageProcess(processName, packageName)
  ) {
    return undefined;
  }
  return { percent, processName };
}

function matchesPackageProcess(processName: string, packageName: string): boolean {
  return processName === packageName || processName.startsWith(`${packageName}:`);
}

function annotateLegacyAndroidCpuError(packageName: string, error: unknown): AppError {
  if (error instanceof AppError) {
    return new AppError(
      error.code,
      error.message,
      { ...(error.details ?? {}), metric: 'cpu', package: packageName },
      error,
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `Failed to sample Android cpu for ${packageName}`,
    { metric: 'cpu', package: packageName },
    error,
  );
}
