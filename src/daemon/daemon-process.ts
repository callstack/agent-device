import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  waitForProcessExit,
} from '../utils/host-process.ts';

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

export async function stopProcessForTakeover(
  pid: number,
  options: {
    termTimeoutMs: number;
    killTimeoutMs: number;
    expectedStartTime: string | undefined;
  },
): Promise<void> {
  if (!isAgentDeviceDaemonProcess(pid, options.expectedStartTime)) return;
  if (!trySignalProcess(pid, 'SIGTERM')) return;
  if (await waitForProcessExit(pid, options.termTimeoutMs)) return;
  if (!trySignalProcess(pid, 'SIGKILL')) return;
  await waitForProcessExit(pid, options.killTimeoutMs);
}
