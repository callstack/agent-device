import type {
  DeviceBootObservation,
  LaunchedProcessCheck,
  LaunchedProcessStopConfirmation,
} from '@agent-device/contracts/device-boot';
import type { AndroidEmulatorLaunchIdentity } from '@agent-device/contracts/device-readiness-runtime';
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

/**
 * Whether `pid` still is the emulator process this host launched, from one `ps` of that pid.
 * Liveness is read separately from the start time because a reaped process leaves no `ps` row, and
 * only `kill(pid, 0)` tells that apart from a `ps` read that failed. The process is `changed` once it
 * is gone, zombie, or carries a different start time — every one of those means the emulator that
 * answers the serial now is somebody else's launch.
 */
export async function checkAndroidEmulatorLaunchProcess(
  identity: AndroidEmulatorLaunchIdentity,
): Promise<LaunchedProcessCheck> {
  const { isProcessAlive, processStartTimesDiffer, readProcessIdentityFacts } =
    await import('@agent-device/host-kit/process');
  let facts: Awaited<ReturnType<typeof readProcessIdentityFacts>>;
  try {
    facts = await readProcessIdentityFacts(identity.pid, PROCESS_IDENTITY_TIMEOUT_MS);
  } catch {
    return 'unverified';
  }
  if (!isProcessAlive(identity.pid) || facts.zombie === true) return 'changed';
  if (processStartTimesDiffer(identity.startTime, facts.startTime)) return 'changed';
  return facts.startTime === identity.startTime ? 'same' : 'unverified';
}

/**
 * Whether the launched emulator process took the shutdown asked of the device through
 * `adb emu kill`. It waits only for the process that command addressed to leave, so an emulator that
 * exits promptly costs one liveness read. A process that ignores the kill is stopped by pid, and
 * host-kit signals that pid only while the recorded start time still names it.
 */
export async function confirmAndroidEmulatorLaunchProcessStopped(
  identity: AndroidEmulatorLaunchIdentity,
): Promise<LaunchedProcessStopConfirmation> {
  const { stopProcessAndConfirmExit, waitForProcessExit } =
    await import('@agent-device/host-kit/process');
  if (await waitForProcessExit(identity.pid, GRACEFUL_SHUTDOWN_EXIT_CONFIRM_MS)) return 'stopped';
  const stop = await stopProcessAndConfirmExit(
    { pid: identity.pid, identity: { startTime: identity.startTime } },
    LAUNCHED_PROCESS_STOP_BUDGET,
  );
  return stop.status === 'stopped' ? 'stopped' : 'unconfirmed';
}

/**
 * Stops the emulator process this host launched for a device nobody owns: it stops the process
 * directly, because no shutdown was ever asked of the device. Host-kit signals the pid only while the
 * recorded start time still names it, so a launch that has already been replaced answers `unconfirmed`
 * rather than stopping somebody else's emulator.
 */
export async function stopAndroidEmulatorLaunchProcess(
  identity: AndroidEmulatorLaunchIdentity,
): Promise<LaunchedProcessStopConfirmation> {
  const { stopProcessAndConfirmExit } = await import('@agent-device/host-kit/process');
  const stop = await stopProcessAndConfirmExit(
    { pid: identity.pid, identity: { startTime: identity.startTime } },
    LAUNCHED_PROCESS_STOP_BUDGET,
  );
  return stop.status === 'stopped' ? 'stopped' : 'unconfirmed';
}

/**
 * Under heavy host load one process-table read took up to 4.2 s. The launch-naming read gets 5 s and
 * a retry because losing it loses the launch; this read is on a close's decision path and answers in
 * tens of milliseconds, so it gets one ordinary process budget instead.
 */
const PROCESS_IDENTITY_TIMEOUT_MS = 1_000;

/**
 * The graceful `adb emu kill` already had its own 15 s to work, so the close path confirms the exit
 * briefly before it escalates to a stop by pid.
 */
const GRACEFUL_SHUTDOWN_EXIT_CONFIRM_MS = 3_000;

/**
 * The stop escalation both callers use: 1.5 s to take SIGTERM and 1.5 s to take SIGKILL, so one stop
 * costs at most 3 s. The close-path caller got that escalation because the graceful `adb emu kill`
 * already had its own 15 s — waiting the same again on a process demonstrably ignoring it would
 * double what one close may spend. This caller never asked the device for a graceful stop: a failed
 * `open` is cleanup on a request that already failed, so TERM does the work and KILL confirms it,
 * inside the same bound rather than on top of another 15 s.
 */
const LAUNCHED_PROCESS_STOP_BUDGET = { termTimeoutMs: 1_500, killTimeoutMs: 1_500 } as const;
