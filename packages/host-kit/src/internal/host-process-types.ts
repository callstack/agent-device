import type { ExecOptions, ExecResult } from './exec.ts';
import type { EnvMap } from '@agent-device/kernel/source-value';

/**
 * What the host says about a process, and what one process-table read needs. Types only:
 * `host-process.ts` re-exports them, nothing imports this module at runtime, so it adds no
 * module to any import closure.
 */
export type HostProcessInfo = {
  pid: number;
  ppid?: number;
  command: string;
};

export type HostProcessIdentityObservation = Readonly<{
  state: string;
  startTime: string;
}>;

/**
 * What the host says about one pid when a caller is about to signal it. Each field is `null`
 * when the host did not answer, which is unknown evidence rather than absence: only a `ps`
 * that names a different process proves the pid changed hands. `zombie` is `null` together
 * with an unreadable process state, since a zombie passes `kill(pid, 0)` and still reports
 * its original start time, so nothing else exposes that it already terminated.
 */
export type HostProcessIdentityFacts = Readonly<{
  startTime: string | null;
  command: string | null;
  zombie: boolean | null;
}>;

export type HostProcessRunCommand = (
  cmd: string,
  args: string[],
  options: ExecOptions,
) => Promise<ExecResult>;

/** The process-shaped object an entry point captures: Node's `process` satisfies it. */
export type HostEnvironmentSource = Readonly<{
  env: EnvMap;
  cwd(): string;
}>;

export type ListHostProcessesOptions = {
  timeoutMs: number;
  runCommand?: HostProcessRunCommand;
};
