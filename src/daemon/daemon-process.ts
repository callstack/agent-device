import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  waitForProcessExit,
} from '../utils/host-process.ts';

const DAEMON_COMMAND_PATTERNS = [
  /(^|[/\s"'=])dist\/src\/daemon\.js($|[\s"'])/,
  /(^|[/\s"'=])dist\/src\/internal\/daemon\.js($|[\s"'])/,
  /(^|[/\s"'=])src\/daemon\.ts($|[\s"'])/,
];

export function isAgentDeviceDaemonCommand(command: string): boolean {
  const normalized = command.toLowerCase().replaceAll('\\', '/');
  if (!normalized.includes('agent-device')) return false;
  return DAEMON_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isAgentDeviceDaemonProcess(pid: number, expectedStartTime?: string): boolean {
  if (!isProcessAlive(pid)) return false;
  if (expectedStartTime) {
    const actualStartTime = readProcessStartTime(pid);
    if (!actualStartTime || actualStartTime !== expectedStartTime) return false;
  }
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
    expectedStartTime?: string;
  },
): Promise<void> {
  if (!isAgentDeviceDaemonProcess(pid, options.expectedStartTime)) return;
  if (!trySignalProcess(pid, 'SIGTERM')) return;
  if (await waitForProcessExit(pid, options.termTimeoutMs)) return;
  if (!trySignalProcess(pid, 'SIGKILL')) return;
  await waitForProcessExit(pid, options.killTimeoutMs);
}
