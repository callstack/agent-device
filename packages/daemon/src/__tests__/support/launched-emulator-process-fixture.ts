import type * as HostProcessModule from '@agent-device/host-kit/process';

/**
 * How the host answers for the emulator process a test session's `open` launched, so a close suite
 * can name which answer the launched-process rule gets without touching the real process table.
 * Cases use the pid named here rather than an arbitrary one: a fabricated pid would be signalled for
 * real if a rule ever aimed a stop at the wrong process, so the seams below answer for this pid only
 * and delegate every other pid to the real host.
 */
export type LaunchedEmulatorProcess = {
  /** The pid `open` recorded for the emulator it launched. */
  pid: number;
  /** The start time `open` recorded for that pid. */
  startTime: string;
  /** Whether `kill(pid, 0)` still finds it. */
  alive: boolean;
  /** Whether the host shows it as a zombie: still answered for, already terminated. */
  zombie: boolean;
  /** The live start time the host reports for it, which may contradict the recorded one. */
  liveStartTime: string;
  /** Whether the host refuses to answer for the pid at all. */
  unreadable: boolean;
  /** Whether the process took the `adb emu kill` the close asked for. */
  exitsOnKill: boolean;
  /** How many times the close read this pid's identity facts. */
  factReads: number;
  /** Every pid a stop escalated to, with the identity it carried. */
  signalAttempts: Array<{ pid: number; startTime?: string }>;
};

const DEFAULTS = {
  pid: 4112,
  startTime: 'launch-start-time',
  alive: true,
  zombie: false,
  liveStartTime: 'launch-start-time',
  unreadable: false,
  exitsOnKill: true,
} as const;

/**
 * The one model the suite's host answers are read from, shared by the mocked module and the cases.
 * A case sets the fields it cares about; `resetLaunchedEmulatorProcess` returns it before the next.
 */
export const launchedEmulatorProcess: LaunchedEmulatorProcess = {
  ...DEFAULTS,
  factReads: 0,
  signalAttempts: [],
};

/** Returns the model to a live launched process that takes the kill, before each case. */
export function resetLaunchedEmulatorProcess(): void {
  Object.assign(launchedEmulatorProcess, DEFAULTS, { factReads: 0 });
  launchedEmulatorProcess.signalAttempts.length = 0;
}

/**
 * The `@agent-device/host-kit/process` answers a close suite needs, over the model above. Only the
 * four reads a close makes about another process are answered this way, and only for the launched
 * pid; the real host keeps answering every other question.
 */
export function launchedEmulatorProcessHost(
  actual: typeof HostProcessModule,
): typeof HostProcessModule {
  const isLaunched = (pid: number) => pid === launchedEmulatorProcess.pid;
  return {
    ...actual,
    isProcessAlive: (pid: number) =>
      isLaunched(pid) ? launchedEmulatorProcess.alive : actual.isProcessAlive(pid),
    readProcessIdentityFacts: async (pid: number, timeoutMs?: number) => {
      if (!isLaunched(pid)) return await actual.readProcessIdentityFacts(pid, timeoutMs);
      launchedEmulatorProcess.factReads += 1;
      if (launchedEmulatorProcess.unreadable) throw new Error('ps timed out after 1000ms');
      return {
        startTime: launchedEmulatorProcess.liveStartTime,
        command: '/sdk/emulator/emulator -avd Pixel_9_API_37',
        zombie: launchedEmulatorProcess.zombie,
      };
    },
    waitForProcessExit: async (pid: number, timeoutMs: number) =>
      isLaunched(pid)
        ? !launchedEmulatorProcess.alive || launchedEmulatorProcess.exitsOnKill
        : await actual.waitForProcessExit(pid, timeoutMs),
    stopProcessAndConfirmExit: async (
      target: HostProcessModule.ProcessStopTarget,
      budget: HostProcessModule.ProcessStopBudget,
    ) => {
      if (!isLaunched(target.pid)) return await actual.stopProcessAndConfirmExit(target, budget);
      launchedEmulatorProcess.signalAttempts.push({
        pid: target.pid,
        startTime: target.identity.startTime,
      });
      return { status: 'stopped', signal: 'SIGTERM' } as const;
    },
  };
}
