import type { DeviceBootObservation } from '@agent-device/contracts/device-boot';
import type { AndroidEmulatorLaunchIdentity } from '@agent-device/contracts/device-readiness-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeadlineClock } from '@agent-device/host-kit/retry';

/** Why one observation of the emulator console listener produced no identity. */
export type AndroidEmulatorGenerationMiss =
  | 'no-listener'
  | 'ambiguous-listener'
  | 'zombie-listener'
  | 'listener-read-timeout'
  | 'process-read-timeout'
  | 'deadline-spent';

export type AndroidEmulatorGenerationReading =
  | Readonly<{ identity: AndroidEmulatorLaunchIdentity }>
  | Readonly<{ miss: AndroidEmulatorGenerationMiss }>;

/**
 * Observe the process listening on the ADB emulator console port without contacting it, with the
 * reason a read produced no identity. A caller that observes more than once passes one deadline,
 * so all reads share one bounded budget.
 */
export async function inspectAndroidEmulatorGeneration(
  device: DeviceInfo,
  options: { deadline?: DeadlineClock } = {},
): Promise<AndroidEmulatorGenerationReading> {
  if (device.platform !== 'android' || device.kind !== 'emulator') return { miss: 'no-listener' };
  const match = /^emulator-(\d+)$/.exec(device.id);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) return { miss: 'no-listener' };
  let last: AndroidEmulatorGenerationMiss = 'deadline-spent';
  for (let attempt = 1; attempt <= LISTENER_PROBE_ATTEMPTS; attempt += 1) {
    const budgetMs = Math.min(
      LISTENER_PROBE_TIMEOUT_MS,
      options.deadline?.remainingMs() ?? LISTENER_PROBE_TIMEOUT_MS,
    );
    if (budgetMs <= 0) return { miss: last };
    const reading = await readConsoleListener(port, budgetMs, options.deadline);
    if (reading.kind === 'identity') return { identity: reading.identity };
    if (reading.kind === 'absent') return { miss: reading.miss };
    last = reading.miss;
  }
  return { miss: last };
}

/**
 * Read the start time of an emulator process this host just launched. It uses the same budget and
 * retry as the console listener read, so a slow `ps` under load still records the launch identity.
 */
export async function readAndroidEmulatorLaunchStartTime(pid: number): Promise<string | null> {
  const { readProcessIdentityFacts } = await import('@agent-device/host-kit/process');
  for (let attempt = 1; attempt <= LISTENER_PROBE_ATTEMPTS; attempt += 1) {
    try {
      const facts = await readProcessIdentityFacts(pid, LISTENER_PROBE_TIMEOUT_MS);
      if (facts.startTime) return facts.startTime;
      if (facts.zombie === true) return null;
    } catch {
      // A timed-out read is retried; the second miss leaves no start time.
    }
  }
  return null;
}

type ConsoleListenerReading =
  | { kind: 'identity'; identity: AndroidEmulatorLaunchIdentity }
  /** The host answered: no single live process listens on the port. A retry cannot change it. */
  | { kind: 'absent'; miss: 'no-listener' | 'ambiguous-listener' | 'zombie-listener' }
  /** The host did not answer in time or a read failed. A retry can still observe the listener. */
  | { kind: 'unread'; miss: 'listener-read-timeout' | 'process-read-timeout' };

/**
 * `lsof -t` prints only process ids, one per line, and exits 1 with no output when nothing listens.
 * An emulator listens on IPv4 and IPv6 from one process, so its id prints once. On macOS, `-b`
 * skips kernel calls that can block under load, and `-w` suppresses the warnings it causes. Linux
 * lsof finds sockets through /proc, and `-b` can stop the port filter from matching there.
 */
async function readConsoleListener(
  port: number,
  budgetMs: number,
  deadline: DeadlineClock | undefined,
): Promise<ConsoleListenerReading> {
  const { hostPlatform, readProcessIdentityFacts } = await import('@agent-device/host-kit/process');
  if (hostPlatform() !== 'darwin' && hostPlatform() !== 'linux') {
    return { kind: 'absent', miss: 'no-listener' };
  }
  let stdout: string;
  try {
    const { runCmd } = await import('@agent-device/host-kit/command');
    const nonBlocking = hostPlatform() === 'darwin' ? ['-b', '-w'] : [];
    const result = await runCmd(
      'lsof',
      [...nonBlocking, '-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
      { allowFailure: true, timeoutMs: budgetMs },
    );
    if (result.exitCode !== 0) return { kind: 'absent', miss: 'no-listener' };
    stdout = result.stdout;
  } catch {
    return { kind: 'unread', miss: 'listener-read-timeout' };
  }
  const pid = soleListenerPid(stdout);
  if (pid === undefined) return { kind: 'absent', miss: 'ambiguous-listener' };
  // The ps read gets only what the shared deadline still has, so lsof and ps together stay inside it.
  const processBudgetMs = Math.min(budgetMs, deadline?.remainingMs() ?? budgetMs);
  if (processBudgetMs <= 0) return { kind: 'unread', miss: 'process-read-timeout' };
  try {
    const facts = await readProcessIdentityFacts(pid, processBudgetMs);
    if (facts.zombie === true) return { kind: 'absent', miss: 'zombie-listener' };
    if (!facts.startTime || facts.zombie !== false) {
      return { kind: 'unread', miss: 'process-read-timeout' };
    }
    return { kind: 'identity', identity: { pid, startTime: facts.startTime } };
  } catch {
    return { kind: 'unread', miss: 'process-read-timeout' };
  }
}

function soleListenerPid(stdout: string): number | undefined {
  const pids = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  if (pids.size !== 1) return undefined;
  const [value] = pids;
  if (!/^[1-9]\d*$/.test(value ?? '')) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

/**
 * Under heavy host load one listener read took up to 4.2 s. Each attempt gets 5 s, and a read that
 * did not answer is tried once more, so a slow host still binds and verifies the launch identity.
 */
const LISTENER_PROBE_TIMEOUT_MS = 5_000;
const LISTENER_PROBE_ATTEMPTS = 2;

/**
 * One budget for the two agreeing observations that bind or verify a launch identity. Open and
 * close each spend at most this long on the probe.
 */
export const ANDROID_EMULATOR_GENERATION_BUDGET_MS = 10_000;

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
