import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  IOS_SYSTEM_SURFACE_HOSTS,
  type IosSystemSurfaceHost,
} from '@agent-device/contracts/ios-system-surface';
import { runAppleToolCommand } from './core/tool-provider.ts';

/**
 * Whether a registered iOS system surface host is running for a Simulator (issue #2438).
 *
 * `unknown` is deliberate and is NOT collapsed into `absent`: the local host AX bridge cannot see a
 * system surface presented over the app — while the sheet is up the app remains the AX `primaryApp`,
 * so the bridge serves the (occluded) app tree, which looks perfectly healthy. Answering `absent`
 * when we do not actually know would silently route such a capture to the bridge and return that
 * occluded tree. Callers route anything that is not `absent` to the XCTest runner, which
 * authoritatively serves the surface only while it is genuinely foreground and otherwise serves the
 * app, so the cost of a false positive is one runner capture instead of a bridge capture.
 *
 * A positive answer names the host it matched, because the capture it routes describes that host's
 * surface rather than the app: the caller stamps the host into the capture's comparison lineage, so
 * a surface capture cannot compare equal to an app capture.
 */
export type SystemSurfacePresence =
  | Readonly<{ kind: 'present'; host: IosSystemSurfaceHost }>
  | 'absent'
  | 'unknown';

export type SystemSurfacePresenceProbe = (
  device: DeviceInfo,
  signal?: AbortSignal,
) => Promise<SystemSurfacePresence>;

/**
 * Only a positive observation is memoized. Absence must never be cached: a sheet opens between two
 * captures, and a cached `absent` would send the very next capture to the bridge and answer from the
 * occluded app tree. Re-probing on every non-present capture is what keeps that window closed.
 */
const PRESENT_MEMO_TTL_MS = 1_000;
const PROBE_TIMEOUT_MS = 3_000;

export function createSystemSurfacePresenceProbe(
  now: () => number = Date.now,
): SystemSurfacePresenceProbe {
  const observedPresent = new Map<string, { at: number; host: IosSystemSurfaceHost }>();
  return async (device, signal) => {
    if (device.kind !== 'simulator') return 'absent';
    const seen = observedPresent.get(device.id);
    if (seen !== undefined && now() - seen.at < PRESENT_MEMO_TTL_MS) {
      return { kind: 'present', host: seen.host };
    }
    observedPresent.delete(device.id);
    const presence = await probeSystemSurfacePresence(device, signal);
    if (presence !== 'absent' && presence !== 'unknown') {
      observedPresent.set(device.id, { at: now(), host: presence.host });
    }
    return presence;
  };
}

async function probeSystemSurfacePresence(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<SystemSurfacePresence> {
  let sawUnknown = false;
  for (const host of IOS_SYSTEM_SURFACE_HOSTS) {
    const pids = await hostProcessIds(host.processExecutable, signal);
    if (pids === 'unknown') {
      sawUnknown = true;
      continue;
    }
    for (const pid of pids) {
      const scoped = await isProcessScopedToDevice(pid, device.id, signal);
      if (scoped === 'unknown') sawUnknown = true;
      else if (scoped) return { kind: 'present', host };
    }
  }
  return sawUnknown ? 'unknown' : 'absent';
}

/**
 * Pids of a host's simulator app binary, host-wide. `pgrep` exits 1 with no output when nothing
 * matches, which is a real negative; any other failure is `unknown`. This stays cheap in the common
 * case — no match means one small process-table scan and no environment read at all.
 */
async function hostProcessIds(
  processExecutable: string,
  signal: AbortSignal | undefined,
): Promise<number[] | 'unknown'> {
  const result = await runProbe('pgrep', ['-f', processExecutable], signal);
  if (result === 'unknown') return 'unknown';
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) return 'unknown';
  return result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

/**
 * Whether one host process belongs to this Simulator. Simulator processes carry `SIMULATOR_UDID` in
 * their environment, so the device scope is exact rather than "some booted simulator". A process
 * that vanished between the scan and this read reports `unknown` rather than a negative, because a
 * dead pid and an unreadable one are indistinguishable here.
 */
async function isProcessScopedToDevice(
  pid: number,
  deviceId: string,
  signal: AbortSignal | undefined,
): Promise<boolean | 'unknown'> {
  const result = await runProbe('ps', ['eww', '-p', String(pid), '-o', 'command='], signal);
  if (result === 'unknown' || result.exitCode !== 0) return 'unknown';
  if (result.stdout.includes(`SIMULATOR_UDID=${deviceId}`)) return true;
  // Only a scope naming a DIFFERENT device is a real negative. A read that carries no device scope
  // at all proves nothing — the environment may have been truncated or withheld — and reporting it
  // as absence would route a live sheet to the occluded app tree.
  return result.stdout.includes('SIMULATOR_UDID=') ? false : 'unknown';
}

async function runProbe(
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number; stdout: string } | 'unknown'> {
  try {
    // Through the Apple tool provider, like every other host probe here, so a stubbed provider
    // answers instead of spawning a real process.
    const result = await runAppleToolCommand(command, args, {
      allowFailure: true,
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return { exitCode: result.exitCode, stdout: result.stdout };
  } catch {
    // A timeout or spawn failure is not evidence of absence.
    return 'unknown';
  }
}
