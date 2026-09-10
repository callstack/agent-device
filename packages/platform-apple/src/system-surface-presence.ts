import type { DeviceInfo } from '@agent-device/kernel/device';
import { runCmd } from '@agent-device/host-kit/command';
import { IOS_SYSTEM_SURFACE_HOSTS } from '@agent-device/contracts/ios-system-surface';

/**
 * Cheap, device-scoped, stateless detection of whether a registered iOS system surface host
 * process is running for a Simulator (issue #2438).
 *
 * The local host AX bridge cannot see a system surface presented over the app — while the sheet is
 * up the app remains the AX `primaryApp`, so the bridge serves the (occluded) app tree, which looks
 * perfectly healthy. Only the XCTest runner can observe the sheet. This probe decides, host-side and
 * without the runner, whether a capture should take the runner path instead of the bridge.
 *
 * "The host process exists for this device" is deliberately conservative: it is true while the
 * sheet is up AND for a while after it is dismissed (the service lingers). Routing to the runner in
 * both cases is correct — the runner authoritatively serves the surface only while it is genuinely
 * foreground (`XCUIApplication.state`), and otherwise serves the app — so the only cost of a false
 * positive is one runner capture instead of a bridge capture. When no host process exists (the
 * overwhelming common case), the bridge fast path is untouched.
 *
 * The probe reads `ps -E` (process list with environment) and matches a host's simulator app-binary
 * path fragment on the same line as `SIMULATOR_UDID=<device>`. `ps` is ~150ms; a short per-device
 * memo keeps a polling `wait` from repaying it on every iteration.
 */
export type SystemSurfacePresenceProbe = (
  device: DeviceInfo,
  signal?: AbortSignal,
) => Promise<boolean>;

const PRESENCE_MEMO_TTL_MS = 1_000;
const PROBE_TIMEOUT_MS = 3_000;

export function createSystemSurfacePresenceProbe(
  now: () => number = Date.now,
): SystemSurfacePresenceProbe {
  const memo = new Map<string, { at: number; present: boolean }>();
  return async (device, signal) => {
    if (device.kind !== 'simulator') return false;
    const cached = memo.get(device.id);
    if (cached && now() - cached.at < PRESENCE_MEMO_TTL_MS) return cached.present;
    const present = await probeSystemSurfacePresence(device, signal);
    memo.set(device.id, { at: now(), present });
    return present;
  };
}

async function probeSystemSurfacePresence(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  let result;
  try {
    result = await runCmd('ps', ['-Awwwo', 'pid=,command=', '-E'], {
      allowFailure: true,
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
  } catch {
    // A probe failure must never fabricate a surface: fall back to the bridge path.
    return false;
  }
  if (result.exitCode !== 0) return false;
  const udidToken = `SIMULATOR_UDID=${device.id}`;
  for (const line of result.stdout.split('\n')) {
    if (!line.includes(udidToken)) continue;
    for (const host of IOS_SYSTEM_SURFACE_HOSTS) {
      if (line.includes(host.processExecutable)) return true;
    }
  }
  return false;
}
