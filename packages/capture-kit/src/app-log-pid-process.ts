import type { LogBackend } from '@agent-device/contracts/observability';
import type {
  AppLogBackgroundProcess,
  AppLogLiveHandle,
  AppLogLiveSnapshot,
  AppLogProcessStart,
  AppLogProcessCommand,
  AppLogRuntimeHost,
} from '@agent-device/contracts/platform';
import { createAppLogLiveHandleFromFinish } from './app-log-live-handle.ts';

export type PidScopedAppLogProcessOptions = Readonly<{
  host: AppLogRuntimeHost;
  backend: LogBackend;
  outputPath: string;
  pidPath: string;
  processStart: AppLogProcessStart;
  setupSignal: AbortSignal;
  resolvePid(signal?: AbortSignal): Promise<string>;
  command(pid: string): AppLogProcessCommand;
  cleanupFailureMessage: string;
}>;

/** Owns the neutral retry and cleanup lifecycle for PID-scoped local log streams. */
export async function createPidScopedAppLogProcess(
  options: PidScopedAppLogProcessOptions,
): Promise<AppLogLiveHandle> {
  const initialPid = await options.resolvePid(options.setupSignal);
  options.setupSignal.throwIfAborted();
  const output = await options.host.outputs.openAppend(options.outputPath);
  let state: AppLogLiveSnapshot['state'] = 'recovering';
  let stopped = false;
  let active: AppLogBackgroundProcess | undefined;
  try {
    options.setupSignal.throwIfAborted();
    if (initialPid) {
      options.setupSignal.throwIfAborted();
      const setupController = new AbortController();
      const forwardAbort = () => setupController.abort(options.setupSignal.reason);
      options.setupSignal.addEventListener('abort', forwardAbort, { once: true });
      try {
        active = await options.processStart(
          {
            command: options.command(initialPid),
            output,
            markerPath: options.pidPath,
          },
          setupController.signal,
        );
      } finally {
        options.setupSignal.removeEventListener('abort', forwardAbort);
      }
      options.setupSignal.throwIfAborted();
      state = 'active';
    }
  } catch (error) {
    await settleCleanupSteps([
      async () => await active?.terminate(),
      async () => {
        await active?.wait;
      },
      async () => await active?.[Symbol.asyncDispose](),
      async () => await output[Symbol.asyncDispose](),
    ]);
    throw error;
  }
  const monitor = monitorPidScopedProcess({
    options,
    output,
    initialProcess: active,
    stopped: () => stopped,
    setActive: (process) => {
      active = process;
    },
    setState: (next) => {
      state = next;
    },
  }).catch(() => {
    state = 'failed';
  });
  let finishPromise: ReturnType<typeof finishPidScopedProcess> | undefined;
  const finish = async () =>
    (finishPromise ??= finishPidScopedProcess({
      options,
      monitor,
      active: () => active,
      stop: () => {
        stopped = true;
      },
      setState: (next) => {
        state = next;
      },
      output,
    }));
  const startedAt = options.host.clock.now();
  return createAppLogLiveHandleFromFinish({
    inspect: () => ({ backend: options.backend, state, startedAt }),
    finish,
  });
}

type PidScopedProcessMonitor = Readonly<{
  options: PidScopedAppLogProcessOptions;
  output: Awaited<ReturnType<AppLogRuntimeHost['outputs']['openAppend']>>;
  initialProcess: AppLogBackgroundProcess | undefined;
  stopped(): boolean;
  setActive(process: AppLogBackgroundProcess | undefined): void;
  setState(state: AppLogLiveSnapshot['state']): void;
}>;

type SubsequentProcessStart =
  | Readonly<{ status: 'stopped' }>
  | Readonly<{ status: 'waiting' }>
  | Readonly<{ status: 'started'; process: AppLogBackgroundProcess }>;

async function monitorPidScopedProcess(input: PidScopedProcessMonitor): Promise<void> {
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
  process: AppLogBackgroundProcess,
): Promise<void> {
  input.setActive(process);
  try {
    if (input.stopped()) await process.terminate();
    input.setState('active');
    await process.wait;
  } finally {
    await disposeAdoptedProcess(input, process);
  }
}

async function pauseBeforeProcessRestart(input: PidScopedProcessMonitor): Promise<void> {
  if (input.stopped()) return;
  input.setState('recovering');
  await input.options.host.clock.sleep(500);
}

async function startAndAdoptSubsequentProcess(
  input: PidScopedProcessMonitor,
): Promise<SubsequentProcessStart> {
  const pid = await input.options.resolvePid();
  if (input.stopped()) return { status: 'stopped' };
  if (!pid) {
    input.setState('recovering');
    await input.options.host.clock.sleep(1_000);
    return { status: 'waiting' };
  }
  const process = await input.options.processStart({
    command: input.options.command(pid),
    output: input.output,
    markerPath: input.options.pidPath,
  });
  input.setActive(process);
  if (!input.stopped()) return { status: 'started', process };
  await stopAdoptedProcess(input, process);
  return { status: 'stopped' };
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

async function finishPidScopedProcess(
  input: Readonly<{
    options: PidScopedAppLogProcessOptions;
    monitor: Promise<void>;
    active(): AppLogBackgroundProcess | undefined;
    stop(): void;
    setState(state: AppLogLiveSnapshot['state']): void;
    output: Awaited<ReturnType<AppLogRuntimeHost['outputs']['openAppend']>>;
  }>,
) {
  input.stop();
  const failures = await settleCleanupSteps([
    async () => await input.active()?.terminate(),
    async () => await input.monitor,
    async () => await input.output[Symbol.asyncDispose](),
  ]);
  if (failures.length > 0) {
    input.setState('failed');
    return {
      status: 'cleanup-pending',
      reason: 'transport-failed',
      message: input.options.cleanupFailureMessage,
    } as const;
  }
  input.setState('ended');
  return {
    status: 'completed',
    result: {
      backend: input.options.backend,
      outputPath: input.options.outputPath,
      completedAt: input.options.host.clock.now(),
    },
  } as const;
}

async function settleCleanupSteps(steps: readonly (() => Promise<void>)[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}
