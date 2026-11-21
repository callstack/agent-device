import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';

/**
 * What one process knows about itself and its machine without asking the host for anything: the
 * platform, the Node it runs, its own pid, whether another pid is still there, and the pid arithmetic
 * that works over rows the caller already holds. This module runs no command, reads no process table
 * and emits no diagnostic, so it is the clean leaf of the process surface. `internal/host-process.ts`
 * is the read side: it runs `ps`, PowerShell and `sysctl`, and takes these facts from here.
 *
 * The line matters because a managed platform package is bundled with its own copy of host-kit. A
 * runtime import of a module that reaches `internal/exec.ts` or `internal/diagnostics.ts` answers with
 * the daemon's process environment and traces into the bundle's own store, outside the request's
 * captured environment and exec trace. The platform package policy derives which host-kit exports a
 * managed package may import from that graph, so what is declared here stays importable and what is
 * not stays with the reads.
 */

/** The process-shaped object an entry point captures: Node's `process` satisfies it. */
export type HostEnvironmentSource = Readonly<{
  env: EnvMap;
  cwd(): string;
}>;

/**
 * Snapshots the environment and working directory of `source`, which an entry point passes as
 * `process`. The environment is copied, so later changes to the source never reach the capture.
 */
export function captureHostEnvironment(source: HostEnvironmentSource): HostEnvironment {
  return { env: { ...source.env }, cwd: source.cwd() };
}

/** One host answer about one pid: what the process table calls its state and birth time. */
export type HostProcessIdentityObservation = Readonly<{
  state: string;
  startTime: string;
}>;

/** One row of a host process table: the pid, its parent when the host named one, and its command. */
export type HostProcessInfo = {
  pid: number;
  ppid?: number;
  command: string;
};

/** Positive proof of different lifetimes; unreadable or mixed-format records prove nothing. */
export function processStartTimesDiffer(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  if (left.startsWith('linux:') !== right.startsWith('linux:')) return false;
  return left !== right;
}

/** Whether the host still has this pid. A refused probe means the process is there. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether the process group of `pid` still exists, on the same refusal rule as a pid probe. */
export function isProcessGroupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function writeHostStderr(value: string): void {
  process.stderr.write(value);
}

export function hostNodeExecutablePath(): string {
  return process.execPath;
}

export function hostNodeVersion(): string {
  return process.version;
}

export function hostPlatform(): NodeJS.Platform {
  return process.platform;
}

/** Whether this host runs Windows, where identity facts come from the CIM table instead of `ps`. */
export function isWindowsHostPlatform(): boolean {
  return process.platform === 'win32';
}

export function hostProcessId(): number {
  return process.pid;
}

/** The pids to act on: integral, positive, deduplicated, and never the excluded one. */
export function uniquePositivePids(
  values: Iterable<number>,
  options: { excludePid?: number } = {},
): number[] {
  return [...new Set(values)].filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid !== options.excludePid,
  );
}

/** Every row of `processes` that descends from `rootPids`, together with those roots. */
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

/** Signals every pid named except this process's own, and counts the ones the host accepted. */
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
