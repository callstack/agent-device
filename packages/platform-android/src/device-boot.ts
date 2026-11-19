import type { DeviceBootObservation } from '@agent-device/contracts/device-boot';
import type { AndroidEmulatorLaunchIdentity } from '@agent-device/contracts/device-readiness-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

/** Observe the process listening on the ADB emulator console port without contacting it. */
export async function observeAndroidEmulatorGeneration(
  device: DeviceInfo,
): Promise<AndroidEmulatorLaunchIdentity | undefined> {
  if (device.platform !== 'android' || device.kind !== 'emulator') return undefined;
  const match = /^emulator-(\d+)$/.exec(device.id);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  try {
    const { hostPlatform, readProcessIdentityFacts } =
      await import('@agent-device/host-kit/process');
    if (hostPlatform() !== 'darwin' && hostPlatform() !== 'linux') return undefined;
    const { runCmd } = await import('@agent-device/host-kit/command');
    const result = await runCmd('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      allowFailure: true,
      timeoutMs: BOOT_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return undefined;
    const pid = soleListenerPid(result.stdout);
    if (pid === undefined) return undefined;
    const facts = await readProcessIdentityFacts(pid, BOOT_PROBE_TIMEOUT_MS);
    if (!facts.startTime || facts.zombie !== false) return undefined;
    return { pid, startTime: facts.startTime };
  } catch {
    return undefined;
  }
}

/**
 * `lsof -F p` prints one `p<pid>` line per process and one `f<fd>` line per listening socket, so an
 * emulator that listens on IPv4 and IPv6 prints `p<pid>`, `f<fd>`, `f<fd>`. The listener counts
 * only when every socket belongs to one process.
 */
function soleListenerPid(stdout: string): number | undefined {
  const pids = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) pids.add(line.slice(1));
  }
  if (pids.size !== 1) return undefined;
  const [value] = pids;
  if (!/^[1-9]\d*$/.test(value ?? '')) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

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
