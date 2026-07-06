import type { ExecOptions, ExecResult } from './exec.ts';
import { runCmd, runCmdSync } from './exec.ts';
import { sleep } from './timeouts.ts';

const PS_TIMEOUT_MS = 1_000;

export type HostProcessInfo = {
  pid: number;
  ppid?: number;
  command: string;
};

type HostProcessRunCommand = (
  cmd: string,
  args: string[],
  options: ExecOptions,
) => Promise<ExecResult>;

export type ListHostProcessesOptions = {
  timeoutMs: number;
  runCommand?: HostProcessRunCommand;
};

export type StopPidsWithEscalationOptions = {
  pids: readonly number[];
  termTimeoutMs: number;
  killTimeoutMs: number;
};

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isProcessGroupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readProcessStartTime(pid: number): string | null {
  return readProcessField(pid, 'lstart=');
}

export function readProcessCommand(pid: number): string | null {
  return readProcessField(pid, 'command=');
}

function readProcessField(pid: number, field: 'lstart=' | 'command='): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = runCmdSync('ps', ['-p', String(pid), '-o', field], {
      allowFailure: true,
      timeoutMs: PS_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function parseHostProcessList(stdout: string): HostProcessInfo[] {
  const processes: HostProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    const command = match[3]!;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    processes.push({ pid, ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : undefined, command });
  }
  return processes;
}

export async function listHostProcesses(
  options: ListHostProcessesOptions,
): Promise<HostProcessInfo[]> {
  const result = await (options.runCommand ?? runCmd)('ps', ['-ax', '-o', 'pid=,ppid=,command='], {
    allowFailure: true,
    timeoutMs: options.timeoutMs,
  });
  if (result.exitCode !== 0) return [];
  return parseHostProcessList(result.stdout);
}

export function expandProcessTree(
  rootPids: readonly number[],
  processes: readonly HostProcessInfo[],
): HostProcessInfo[] {
  const selected = new Set(uniquePositivePids(rootPids));
  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes) {
      if (processInfo.ppid === undefined || !selected.has(processInfo.ppid)) continue;
      if (selected.has(processInfo.pid)) continue;
      selected.add(processInfo.pid);
      changed = true;
    }
  }
  return processes.filter((processInfo) => selected.has(processInfo.pid));
}

export function uniquePositivePids(
  values: Iterable<number>,
  options: { excludePid?: number } = {},
): number[] {
  return [...new Set(values)].filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid !== options.excludePid,
  );
}

export function signalPidsBestEffort(
  pidsToSignal: readonly number[],
  signal: NodeJS.Signals,
): number {
  const pids = uniquePositivePids(pidsToSignal, { excludePid: process.pid });
  let signaled = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signaled += 1;
    } catch {
      // Process already exited or cannot be signaled; cleanup remains best-effort.
    }
  }
  return signaled;
}

export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(50);
    if (!isProcessAlive(pid)) return true;
  }
  return !isProcessAlive(pid);
}

export async function stopPidsWithEscalation(
  options: StopPidsWithEscalationOptions,
): Promise<void> {
  const pids = uniquePositivePids(options.pids, { excludePid: process.pid });
  if (pids.length === 0) return;
  signalPidsBestEffort(pids, 'SIGTERM');
  await Promise.all(pids.map(async (pid) => await waitForProcessExit(pid, options.termTimeoutMs)));
  const livePids = pids.filter((pid) => isProcessAlive(pid));
  signalPidsBestEffort(livePids, 'SIGKILL');
  await Promise.all(pids.map(async (pid) => await waitForProcessExit(pid, options.killTimeoutMs)));
}
