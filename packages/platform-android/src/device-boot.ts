import type { DeviceBootObservation } from '@agent-device/contracts/device-boot';
import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * Reads the start time of an emulator process this host just launched. One `ps` of that pid gets
 * 5 s, and a read that did not answer is tried once more, so a slow host still records the launch.
 */
export async function readAndroidEmulatorLaunchStartTime(pid: number): Promise<string | null> {
  const { readProcessIdentityFacts } = await import('@agent-device/host-kit/process');
  for (let attempt = 1; attempt <= LAUNCH_START_TIME_ATTEMPTS; attempt += 1) {
    try {
      const facts = await readProcessIdentityFacts(pid, LAUNCH_START_TIME_TIMEOUT_MS);
      if (facts.startTime) return facts.startTime;
      if (facts.zombie === true) return null;
    } catch {
      // A timed-out read is retried; the second miss leaves no start time.
    }
  }
  return null;
}

/**
 * Under heavy host load one process-table read took up to 4.2 s, which is why the read that names
 * a launch gets 5 s and one retry rather than host-kit's ordinary 1 s process budget.
 */
const LAUNCH_START_TIME_TIMEOUT_MS = 5_000;
const LAUNCH_START_TIME_ATTEMPTS = 2;

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
    const { runAndroidShell } = await import('./adb.ts');
    const result = await runAndroidShell(device, ['cat', '/proc/uptime'], {
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
