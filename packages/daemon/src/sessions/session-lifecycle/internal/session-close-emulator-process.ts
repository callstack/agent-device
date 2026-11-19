// #4585: a plain `close` owes a stop to the boot its own `open` caused, and on Android the host
// half of that boot is one emulator process this daemon launched and recorded. This module is the
// one owner of the rule that names that process: read it, and stop nothing else.
import type { AndroidEmulatorLaunchIdentity } from '@agent-device/contracts/device-readiness-runtime';
import {
  isProcessAlive,
  processStartTimesDiffer,
  readProcessIdentityFacts,
  stopProcessAndConfirmExit,
  waitForProcessExit,
} from '@agent-device/host-kit/process';

/**
 * What the host says about the launched emulator process, read once immediately before a stop.
 * `same` is the only answer that lets the stop proceed: `changed` is positive evidence that the
 * recorded process is gone, so whoever answers the serial now is not this session's launch, and
 * `unverified` means the host could not name the live process at all.
 */
export type AndroidEmulatorProcessCheck = 'same' | 'changed' | 'unverified';

/**
 * {@link AndroidEmulatorProcessCheck} for one recorded launch, from one `ps` of the recorded pid.
 * Liveness is read separately from the start time because a reaped process leaves no `ps` row, and
 * only `kill(pid, 0)` tells that apart from a `ps` read that failed.
 */
export async function checkAndroidEmulatorProcess(
  identity: AndroidEmulatorLaunchIdentity,
): Promise<AndroidEmulatorProcessCheck> {
  let facts: Awaited<ReturnType<typeof readProcessIdentityFacts>>;
  try {
    facts = await readProcessIdentityFacts(identity.pid);
  } catch {
    return 'unverified';
  }
  if (!isProcessAlive(identity.pid) || facts.zombie === true) return 'changed';
  if (processStartTimesDiffer(identity.startTime, facts.startTime)) return 'changed';
  return facts.startTime === identity.startTime ? 'same' : 'unverified';
}

/**
 * Whether the launched process took the shutdown it was asked for through `adb emu kill`. It waits
 * only for the process that command addressed to leave, so an emulator that exits promptly costs
 * one liveness read. A process that ignores the kill is stopped by pid, and host-kit signals that
 * pid only while the recorded start time still names it.
 */
export async function confirmAndroidEmulatorProcessStopped(
  identity: AndroidEmulatorLaunchIdentity,
): Promise<'stopped' | 'unconfirmed'> {
  if (await waitForProcessExit(identity.pid, GRACEFUL_SHUTDOWN_EXIT_CONFIRM_MS)) return 'stopped';
  const stop = await stopProcessAndConfirmExit(
    { pid: identity.pid, identity: { startTime: identity.startTime } },
    LAUNCHED_PROCESS_STOP_BUDGET,
  );
  return stop.status === 'stopped' ? 'stopped' : 'unconfirmed';
}

/**
 * The graceful `adb emu kill` already had its own 15 s to work. Waiting the same again on a process
 * that is demonstrably ignoring it would double what one close may spend, so this confirms the exit
 * briefly and then escalates.
 */
const GRACEFUL_SHUTDOWN_EXIT_CONFIRM_MS = 3_000;
const LAUNCHED_PROCESS_STOP_BUDGET = { termTimeoutMs: 1_500, killTimeoutMs: 1_500 } as const;
