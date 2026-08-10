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
import { monitorPidScopedProcess } from './app-log-pid-monitor.ts';

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
    initialProcess: active && initialPid ? { pid: initialPid, process: active } : undefined,
    stopped: () => stopped,
    setActive: (process) => {
      active = process;
    },
    setState: (next) => {
      state = next;
    },
    resolvePid: async () => await options.resolvePid(),
    startProcess: async (pid) =>
      await options.processStart({
        command: options.command(pid),
        output,
        markerPath: options.pidPath,
      }),
    sleep: async (milliseconds, signal) => await options.host.clock.sleep(milliseconds, signal),
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
