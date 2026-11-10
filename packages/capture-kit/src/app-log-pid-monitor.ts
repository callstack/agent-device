import type {
  AppLogBackgroundProcess,
  AppLogLiveSnapshot,
} from '@agent-device/contracts/app-log-runtime';

export type PidScopedProcess = Readonly<{
  pid: string;
  process: AppLogBackgroundProcess;
}>;

export type PidScopedProcessMonitor = Readonly<{
  initialProcess: PidScopedProcess | undefined;
  stopped(): boolean;
  setActive(process: AppLogBackgroundProcess | undefined): void;
  setState(state: AppLogLiveSnapshot['state']): void;
  resolvePid(): Promise<string>;
  startProcess(pid: string): Promise<AppLogBackgroundProcess>;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}>;

type SubsequentProcessStart =
  | Readonly<{ status: 'stopped' }>
  | Readonly<{ status: 'waiting' }>
  | Readonly<{ status: 'started'; process: PidScopedProcess }>;

/** Monitors a PID-scoped stream and rotates it when the application process changes. */
export async function monitorPidScopedProcess(input: PidScopedProcessMonitor): Promise<void> {
  let process = input.initialProcess;
  while (!input.stopped()) {
    if (process) {
      await settleActiveProcess(input, process);
      process = undefined;
      await pauseBeforeProcessRestart(input);
      continue;
    }

    const started = await startAndAdoptSubsequentProcess(input);
    if (started.status === 'stopped') return;
    if (started.status === 'waiting') continue;
    process = started.process;
  }
}

async function settleActiveProcess(
  input: PidScopedProcessMonitor,
  scopedProcess: PidScopedProcess,
): Promise<void> {
  const { process } = scopedProcess;
  input.setActive(process);
  try {
    input.setState('active');
    await observeActiveProcess(input, scopedProcess);
  } finally {
    await disposeAdoptedProcess(input, process);
  }
}

async function observeActiveProcess(
  input: PidScopedProcessMonitor,
  scopedProcess: PidScopedProcess,
): Promise<void> {
  const wait = observeProcessWait(scopedProcess.process);
  try {
    await pollActiveProcessPid(input, scopedProcess, wait);
    await terminateStoppedProcess(input, scopedProcess.process, wait);
    await assertProcessWaitSucceeded(wait.outcome);
  } finally {
    wait.controller.abort();
  }
}

type ProcessWaitObservation = Readonly<{
  controller: AbortController;
  outcome: Promise<Readonly<{ status: 'exited' }> | Readonly<{ status: 'failed'; error: unknown }>>;
  settled(): boolean;
}>;

function observeProcessWait(process: AppLogBackgroundProcess): ProcessWaitObservation {
  const controller = new AbortController();
  let settled = false;
  const finish = () => {
    settled = true;
    controller.abort();
  };
  const outcome = process.wait.then(
    () => {
      finish();
      return { status: 'exited' } as const;
    },
    (error: unknown) => {
      finish();
      return { status: 'failed', error } as const;
    },
  );
  return { controller, outcome, settled: () => settled };
}

async function pollActiveProcessPid(
  input: PidScopedProcessMonitor,
  scopedProcess: PidScopedProcess,
  wait: ProcessWaitObservation,
): Promise<void> {
  while (!input.stopped() && !wait.settled()) {
    if (!(await waitForPidPoll(input, wait))) return;
    const observedPid = await resolvePidOrUnknown(input);
    if (input.stopped()) return;
    // An unanswered poll proves no process change, so the running stream keeps capturing.
    if (observedPid === undefined || observedPid === scopedProcess.pid) continue;
    await scopedProcess.process.terminate();
    return;
  }
}

async function waitForPidPoll(
  input: PidScopedProcessMonitor,
  wait: ProcessWaitObservation,
): Promise<boolean> {
  try {
    await input.sleep(500, wait.controller.signal);
  } catch (error) {
    if (!wait.settled()) throw error;
  }
  return !wait.settled();
}

async function terminateStoppedProcess(
  input: PidScopedProcessMonitor,
  process: AppLogBackgroundProcess,
  wait: ProcessWaitObservation,
): Promise<void> {
  if (input.stopped() && !wait.settled()) await process.terminate();
}

async function assertProcessWaitSucceeded(
  outcome: ProcessWaitObservation['outcome'],
): Promise<void> {
  const settled = await outcome;
  if (settled.status === 'failed') throw settled.error;
}

async function pauseBeforeProcessRestart(input: PidScopedProcessMonitor): Promise<void> {
  if (input.stopped()) return;
  input.setState('recovering');
  await input.sleep(500);
}

async function startAndAdoptSubsequentProcess(
  input: PidScopedProcessMonitor,
): Promise<SubsequentProcessStart> {
  const pid = await resolvePidOrUnknown(input);
  if (input.stopped()) return { status: 'stopped' };
  if (!pid) {
    input.setState('recovering');
    await input.sleep(1_000);
    return { status: 'waiting' };
  }
  const process = await input.startProcess(pid);
  input.setActive(process);
  if (!input.stopped()) return { status: 'started', process: { pid, process } };
  await stopAdoptedProcess(input, process);
  return { status: 'stopped' };
}

/**
 * A PID poll is a best-effort probe (one `pidof` under its own timeout). A failed poll is retried on
 * the next tick instead of ending capture for the rest of the session.
 */
async function resolvePidOrUnknown(input: PidScopedProcessMonitor): Promise<string | undefined> {
  try {
    return await input.resolvePid();
  } catch {
    return undefined;
  }
}

async function stopAdoptedProcess(
  input: PidScopedProcessMonitor,
  process: AppLogBackgroundProcess,
): Promise<void> {
  try {
    await process.terminate();
    await process.wait;
  } finally {
    await disposeAdoptedProcess(input, process);
  }
}

async function disposeAdoptedProcess(
  input: PidScopedProcessMonitor,
  process: AppLogBackgroundProcess,
): Promise<void> {
  try {
    await process[Symbol.asyncDispose]();
  } finally {
    input.setActive(undefined);
  }
}
