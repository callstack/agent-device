import {
  isProcessAlive,
  readHostProcessIdentityObservations,
  readProcessCommand,
  readProcessStartTime,
} from '../utils/host-process.ts';
import { sleep } from '../utils/timeouts.ts';

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
  /** The pid no longer belongs to the identity: it exited, or the host recycled it. */
  exited: boolean;
  elapsedMs: number;
};

/**
 * Poll for {@link waitForDaemonExit}. {@link classifyDaemonPid} reads `ps` only
 * once the cheap liveness check says the pid is still taken, so a daemon that has
 * already gone costs no subprocess at all.
 */
const DAEMON_EXIT_POLL_MS = 100;

/**
 * What a pid is doing relative to the identity that claimed it. `exiting` is the
 * state a bare liveness read cannot express: `kill(pid, 0)` still succeeds for a
 * process that has died but has not been reaped yet, while `ps` has already
 * dropped its row — a pid on its way out, not a pid handed to somebody else.
 */
type DaemonPidState = 'ours' | 'exiting' | 'released' | 'recycled';

function classifyDaemonPid(identity: DaemonProcessIdentity): DaemonPidState {
  if (!isProcessAlive(identity.pid)) return 'released';
  // State and start time in one `ps` read. A process that has died but has not
  // been reaped answers kill(pid, 0) AND still reports its original start time,
  // so the state is the only field that separates it from one still running —
  // and its command reads `<defunct>`, which would otherwise look like a pid
  // handed to a different program.
  const observed = readHostProcessIdentityObservations([identity.pid]).get(identity.pid);
  if (!observed || observed.state.startsWith('Z')) return 'exiting';
  if (observed.startTime !== identity.startTime) return 'recycled';
  const command = readProcessCommand(identity.pid);
  if (!command) return 'exiting';
  return isAgentDeviceDaemonCommand(command) ? 'ours' : 'recycled';
}

/**
 * Waits for a daemon identity to leave the host. Two endings count as exited: the
 * pid was released, or the host handed it to someone else. Recycling is the one a
 * bare liveness wait gets wrong — it reports a stranger's pid as "still running",
 * which is what lets a grace wait escalate a SIGKILL onto an unrelated process —
 * so escalating callers must branch on this result, never on bare liveness. A pid
 * still being torn down is neither ending, so the wait keeps polling and callers
 * retain the old guarantee that the number is free before they act on it.
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

/**
 * The only way this module signals a daemon: identity is re-read immediately
 * before the write, so a pid recycled since the last observation cannot be
 * signaled at all. Escalation safety is then a property of the call, not a rule
 * each call site has to remember.
 */
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
