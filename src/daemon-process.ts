import {
  isProcessAlive,
  readHostProcessIdentityObservations,
  readProcessCommand,
  readProcessStartTime,
  type OwnerIdentity,
} from '@agent-device/host-kit/process';
import { sleep } from '@agent-device/host-kit/retry';

const DAEMON_COMMAND_PATTERNS = [
  /\/dist\/src\/daemon\.js($|[\s"'])/,
  /\/dist\/src\/internal\/daemon\.js($|[\s"'])/,
  /\/src\/daemon\.ts($|[\s"'])/,
];

/**
 * Identity is the daemon entry path, never the checkout's directory name: a
 * git worktree is named after its branch, so a `agent-device` substring gate
 * classified every worktree daemon as "not ours" (#1545). The pid always
 * comes from our own daemon.json/daemon.lock alongside the processStartTime
 * recorded with it. Missing identity must fail closed so a stale PID cannot
 * be authorized by the path match alone.
 */
export function isAgentDeviceDaemonCommand(command: string): boolean {
  const normalized = command.toLowerCase().replaceAll('\\', '/');
  return DAEMON_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isAgentDeviceDaemonProcess(
  pid: number,
  expectedStartTime: string | undefined,
): boolean {
  if (!expectedStartTime) return false;
  if (!isProcessAlive(pid)) return false;
  const actualStartTime = readProcessStartTime(pid);
  if (!actualStartTime || actualStartTime !== expectedStartTime) return false;
  const command = readProcessCommand(pid);
  if (!command) return false;
  return isAgentDeviceDaemonCommand(command);
}

function trySignalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw error;
  }
}

/** A daemon pinned to one process lifetime, never a bare pid. */
export type DaemonProcessIdentity = Readonly<{
  pid: number;
  startTime: string;
}>;

export type DaemonExitWait = {
  /** The pid was released, or the host handed it to a different process. */
  exited: boolean;
  elapsedMs: number;
};

const DAEMON_EXIT_POLL_MS = 100;

/**
 * Resolves once `identity` has left the host — released or recycled. A pid still
 * being torn down is neither, so the wait continues until the number is free.
 */
export async function waitForDaemonExit(
  identity: DaemonProcessIdentity,
  options: { timeoutMs: number; pollMs?: number },
): Promise<DaemonExitWait> {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const pollMs = options.pollMs ?? DAEMON_EXIT_POLL_MS;
  const hasExited = (): boolean => {
    if (!isProcessAlive(identity.pid)) return true;
    const observed = readHostProcessIdentityObservations([identity.pid]).get(identity.pid);
    return Boolean(observed?.startTime && observed.startTime !== identity.startTime);
  };
  let exited = hasExited();
  while (!exited && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    exited = hasExited();
  }
  return { exited, elapsedMs: Date.now() - startedAt };
}

export type DaemonTerminationResult =
  /** A released bare PID, without lifetime proof or metadata cleanup authority. */
  | Readonly<{ status: 'not-running' }>
  | Readonly<{
      status: 'exited';
      identity: DaemonProcessIdentity;
      mode: 'already-exited' | 'graceful' | 'forced';
    }>
  | Readonly<{
      status: 'retained';
      reason: 'missing-start-time' | 'identity-unverified' | 'signal-failed' | 'exit-timeout';
      signal?: NodeJS.Signals;
    }>;

/** Owns every signal and exit wait for one observed daemon lifetime. */
export async function stopDaemonProcess(
  observed: Readonly<OwnerIdentity>,
  options: {
    mode: 'graceful' | 'force';
    termTimeoutMs: number;
    killTimeoutMs: number;
  },
): Promise<DaemonTerminationResult> {
  if (!observed.startTime?.trim()) {
    if (!isProcessAlive(observed.pid)) return { status: 'not-running' };
    return { status: 'retained', reason: 'missing-start-time' };
  }
  const identity: DaemonProcessIdentity = { pid: observed.pid, startTime: observed.startTime };
  if ((await waitForDaemonExit(identity, { timeoutMs: 0 })).exited) {
    return { status: 'exited', identity, mode: 'already-exited' };
  }
  let previousSignal: 'SIGTERM' | undefined;
  if (options.mode === 'graceful') {
    const result = await signalAndWaitForDaemonExit(identity, {
      signal: 'SIGTERM',
      timeoutMs: options.termTimeoutMs,
    });
    if (result.status !== 'survived') return result;
    previousSignal = 'SIGTERM';
  }
  const result = await signalAndWaitForDaemonExit(identity, {
    signal: 'SIGKILL',
    timeoutMs: options.killTimeoutMs,
    previousSignal,
  });
  return result.status === 'survived' ? { status: 'retained', reason: 'exit-timeout' } : result;
}

async function signalAndWaitForDaemonExit(
  identity: DaemonProcessIdentity,
  options: { signal: 'SIGTERM' | 'SIGKILL'; timeoutMs: number; previousSignal?: 'SIGTERM' },
): Promise<DaemonTerminationResult | Readonly<{ status: 'survived' }>> {
  const verified = isAgentDeviceDaemonProcess(identity.pid, identity.startTime);
  const signaled = verified && trySignalProcess(identity.pid, options.signal);
  const mode = signaled
    ? options.signal === 'SIGTERM'
      ? 'graceful'
      : 'forced'
    : options.previousSignal
      ? 'graceful'
      : 'already-exited';
  const wait = await waitForDaemonExit(identity, {
    timeoutMs: mode === 'already-exited' ? 0 : options.timeoutMs,
  });
  if (wait.exited) return { status: 'exited', identity, mode };
  if (signaled) return { status: 'survived' };
  return {
    status: 'retained',
    signal: options.signal,
    reason: verified ? 'signal-failed' : 'identity-unverified',
  };
}
