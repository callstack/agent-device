import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runHarmonyHdc } from './hdc.ts';

export const HARMONYOS_MEMORY_SAMPLE_METHOD = 'hdc-shell-proc-status';
export const HARMONYOS_MEMORY_SAMPLE_DESCRIPTION =
  'Resident memory snapshot from HarmonyOS /proc/<pid>/status. Values are reported in kilobytes.';

export type HarmonyMemoryPerfSample = {
  totalRssKb: number;
  peakRssKb?: number;
  measuredAt: string;
  method: typeof HARMONYOS_MEMORY_SAMPLE_METHOD;
  pid: number;
};

export function parseHarmonyPid(rawOutput: string): number | undefined {
  const first = rawOutput.trim().split(/\s+/)[0];
  if (!first || !/^\d+$/.test(first)) return undefined;
  const pid = Number.parseInt(first, 10);
  return pid > 0 ? pid : undefined;
}

export function parseHarmonyProcStatusMemory(rawOutput: string):
  | {
      totalRssKb: number;
      peakRssKb?: number;
    }
  | undefined {
  const rss = readProcStatusKb(rawOutput, 'VmRSS');
  if (rss === undefined) return undefined;
  const peakRssKb = readProcStatusKb(rawOutput, 'VmHWM');
  return { totalRssKb: rss, ...(peakRssKb === undefined ? {} : { peakRssKb }) };
}

export async function sampleHarmonyMemoryPerf(
  device: DeviceInfo,
  bundleName: string,
): Promise<HarmonyMemoryPerfSample> {
  const pid = await resolveHarmonyProcessPid(device, bundleName);
  const result = await runHarmonyHdc(device, ['shell', 'cat', `/proc/${pid}/status`], {
    timeoutMs: 15_000,
  });
  const memory = parseHarmonyProcStatusMemory(result.stdout);
  if (!memory) {
    throw new AppError('COMMAND_FAILED', `Could not read resident memory for ${bundleName}`, {
      hint: 'Verify the app is still running, then retry perf memory sample.',
      details: { bundleName, pid },
    });
  }
  return {
    ...memory,
    measuredAt: new Date().toISOString(),
    method: HARMONYOS_MEMORY_SAMPLE_METHOD,
    pid,
  };
}

async function resolveHarmonyProcessPid(device: DeviceInfo, bundleName: string): Promise<number> {
  const result = await runHarmonyHdc(device, ['shell', 'pidof', bundleName], {
    allowFailure: true,
    timeoutMs: 15_000,
  });
  const pid = result.exitCode === 0 ? parseHarmonyPid(result.stdout) : undefined;
  if (pid !== undefined) return pid;
  throw new AppError('COMMAND_FAILED', `Could not find a running process for ${bundleName}`, {
    hint: 'Open the app in this session, then retry perf memory sample.',
    details: { bundleName },
  });
}

function readProcStatusKb(rawOutput: string, key: string): number | undefined {
  const match = rawOutput.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm'));
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}
