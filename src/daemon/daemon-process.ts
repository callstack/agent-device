import {
  isProcessAlive,
  readHostProcessIdentityObservations,
  readProcessCommand,
  readProcessStartTime,
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

export function trySignalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw err;
  }
}

/** A daemon pinned to one process lifetime, never a bare pid. */
export type DaemonProcessIdentity = {
  pid: number;
  startTime: string;
};

export type DaemonExitWait = {
  /** The pid was released, or the host handed it to a different process. */
  exited: boolean;
  elapsedMs: number;
};

const DAEMON_EXIT_POLL_MS = 100;

type DaemonPidState = 'ours' | 'exiting' | 'released' | 'recycled';

function classifyDaemonPid(identity: DaemonProcessIdentity): DaemonPidState {
  if (!isProcessAlive(identity.pid)) return 'released';
  // A terminated pid awaiting reap answers kill(pid, 0), keeps its start time, and
  // reports its command as `<defunct>`; only the process state distinguishes it.
  const observed = readHostProcessIdentityObservations([identity.pid]).get(identity.pid);
  if (!observed || observed.state.startsWith('Z')) return 'exiting';
  if (observed.startTime !== identity.startTime) return 'recycled';
  const command = readProcessCommand(identity.pid);
  if (!command) return 'exiting';
  return isAgentDeviceDaemonCommand(command) ? 'ours' : 'recycled';
}

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
    const state = classifyDaemonPid(identity);
    return state === 'released' || state === 'recycled';
  };
  let exited = hasExited();
  while (!exited && Date.now() < deadline) {
    await sleep(pollMs);
    exited = hasExited();
  }
  return { exited, elapsedMs: Date.now() - startedAt };
}

function signalDaemonIdentity(identity: DaemonProcessIdentity, signal: NodeJS.Signals): boolean {
  if (!isAgentDeviceDaemonProcess(identity.pid, identity.startTime)) return false;
  return trySignalProcess(identity.pid, signal);
}

export async function stopProcessForTakeover(
  pid: number,
  options: {
    termTimeoutMs: number;
    killTimeoutMs: number;
    expectedStartTime: string | undefined;
  },
): Promise<void> {
  if (!options.expectedStartTime) return;
  const identity: DaemonProcessIdentity = { pid, startTime: options.expectedStartTime };
  if (!signalDaemonIdentity(identity, 'SIGTERM')) return;
  if ((await waitForDaemonExit(identity, { timeoutMs: options.termTimeoutMs })).exited) return;
  if (!signalDaemonIdentity(identity, 'SIGKILL')) return;
  await waitForDaemonExit(identity, { timeoutMs: options.killTimeoutMs });
}
