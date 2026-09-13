import type { DeviceBootObservation } from '@agent-device/contracts/device-boot';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { runCmd } from '@agent-device/host-kit/command';

/**
 * CoreSimulator runs exactly one `launchd_sim` per booted device, naming that device's
 * `data/var/run/launchd_bootstrap.plist` in its arguments. The process therefore IS the boot: its
 * start time is when this incarnation of the device began, on the host clock, and no booted
 * simulator is missing it.
 */
const SIMULATOR_LAUNCHD_PROCESS = 'launchd_sim';

/** The probe answers in tens of milliseconds and must not become the reason an `open` waits. */
const BOOT_PROBE_TIMEOUT_MS = 2_000;

/** `ps -o lstart` prints weekday and month names in the caller's locale; only the C form is parsed. */
const C_LOCALE_ENV = { LC_ALL: 'C' };

const PS_PROCESS_ROW =
  /^(\d+)\s+([A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/;

const PS_PROCESS_START = /^[A-Za-z]{3} ([A-Za-z]{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

const PS_MONTHS = new Map<string, number>([
  ['Jan', 0],
  ['Feb', 1],
  ['Mar', 2],
  ['Apr', 3],
  ['May', 4],
  ['Jun', 5],
  ['Jul', 6],
  ['Aug', 7],
  ['Sep', 8],
  ['Oct', 9],
  ['Nov', 10],
  ['Dec', 11],
]);

export async function observeSimulatorBootTimeMs(
  device: DeviceInfo,
): Promise<DeviceBootObservation> {
  if (!isIosFamily(device) || device.kind !== 'simulator') {
    return { observed: false, reason: 'unsupported-device' };
  }
  const pids = await readLaunchdSimPids();
  if (pids.length === 0) return { observed: false, reason: 'unobserved' };
  const bootedAtMs = newestLaunchdSimBootMs(await readProcessRows(pids), device.id);
  return bootedAtMs === undefined
    ? { observed: false, reason: 'unobserved' }
    : { observed: true, bootedAtMs };
}

async function readLaunchdSimPids(): Promise<number[]> {
  const result = await runProbe('/usr/bin/pgrep', ['-x', SIMULATOR_LAUNCHD_PROCESS]);
  if (result === undefined) return [];
  return result
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function readProcessRows(pids: readonly number[]): Promise<string> {
  return (
    (await runProbe(
      '/bin/ps',
      ['-p', pids.join(','), '-o', 'pid=,lstart=,command='],
      C_LOCALE_ENV,
    )) ?? ''
  );
}

async function runProbe(
  executable: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<string | undefined> {
  try {
    const result = await runCmd(executable, [...args], {
      allowFailure: true,
      timeoutMs: BOOT_PROBE_TIMEOUT_MS,
      ...(env ? { env } : {}),
    });
    return result.exitCode === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The newest boot among the rows naming this device's Simulator bootstrap, rejected once observed. */
function newestLaunchdSimBootMs(psOutput: string, udid: string): number | undefined {
  const nowMs = Date.now();
  let newest: number | undefined;
  for (const line of psOutput.split('\n')) {
    const startedAtMs = readLaunchdSimStartMs(line, udid);
    // A boot that begins after this instant is a host clock that moved underneath the probe, which
    // proves nothing about the device; the caller stays as cautious as it was before the probe.
    if (startedAtMs === undefined || startedAtMs > nowMs) continue;
    if (newest === undefined || startedAtMs > newest) newest = startedAtMs;
  }
  return newest;
}

function readLaunchdSimStartMs(line: string, udid: string): number | undefined {
  const [, lstart, command] = PS_PROCESS_ROW.exec(line)?.slice(1) ?? [];
  if (lstart === undefined || command === undefined) return undefined;
  if (!isLaunchdSimForDevice(command, udid)) return undefined;
  return parseProcessStartTimeMs(lstart);
}

function isLaunchdSimForDevice(command: string, udid: string): boolean {
  const [executable, ...args] = command.trim().split(/\s+/);
  return (
    executable !== undefined &&
    executable.split('/').pop() === SIMULATOR_LAUNCHD_PROCESS &&
    args.some((arg) => arg.includes(udid))
  );
}

/** Reads the `Sun Sep 13 09:43:16 2026` form `ps -o lstart` prints under the C locale, in local time. */
function parseProcessStartTimeMs(lstart: string): number | undefined {
  const [, month, day, hour, minute, second, year] = PS_PROCESS_START.exec(lstart.trim()) ?? [];
  const monthIndex = month === undefined ? undefined : PS_MONTHS.get(month);
  if (monthIndex === undefined) return undefined;
  const startedAtMs = new Date(
    Number(year),
    monthIndex,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime();
  return Number.isFinite(startedAtMs) ? startedAtMs : undefined;
}
