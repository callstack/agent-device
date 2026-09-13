import type { DeviceBootObservation } from '@agent-device/contracts/device-boot';
import type { DeviceInfo } from '@agent-device/kernel/device';

/** The probe answers in tens of milliseconds and must not become the reason an `open` waits. */
const BOOT_PROBE_TIMEOUT_MS = 3_000;

const UPTIME_FIELDS = /^\s*(\d+(?:\.\d+)?)/;

/**
 * When this device's current boot began, derived from how long it has been up rather than from any
 * clock it keeps itself. `/proc/uptime` is a duration, so the host clock supplies the absolute
 * instant and a guest wall clock that disagrees with the host cannot move the answer — which is why
 * this does not read the guest-clock stamps `/proc/stat`'s `btime` and `ro.runtime.firstboot` offer.
 */
export async function observeAndroidBootTimeMs(device: DeviceInfo): Promise<DeviceBootObservation> {
  const probeStartedAtMs = Date.now();
  const uptimeSeconds = await readUptimeSeconds(device);
  if (uptimeSeconds === undefined) return { observed: false, reason: 'unobserved' };
  // The sample was taken at or after the probe began, so this bound is never later than the real
  // boot instant. Reading the clock after the response instead would let transport latency push the
  // answer forward and condemn a claim taken after the reboot to look stale.
  return { observed: true, bootedAtMs: probeStartedAtMs - uptimeSeconds * 1000 };
}

async function readUptimeSeconds(device: DeviceInfo): Promise<number | undefined> {
  try {
    const { runAndroidAdb } = await import('./adb.ts');
    const result = await runAndroidAdb(device, ['shell', 'cat', '/proc/uptime'], {
      allowFailure: true,
      timeoutMs: BOOT_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return undefined;
    const seconds = Number.parseFloat(UPTIME_FIELDS.exec(result.stdout)?.[1] ?? '');
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}
