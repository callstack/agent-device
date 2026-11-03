import { AppError } from '@agent-device/kernel/errors';
import { randomUUID } from 'node:crypto';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { Deadline, emitDiagnostic } from './host.ts';
import { disposeRunnerSession, waitForRunnerLaunchExit } from './runner-disposal.ts';
import { mintRunnerToken } from './runner-contract.ts';
import { logChunk, resolveRunnerLaunchLogPath, flushRunnerLogAppends } from './runner-io.ts';
import type { RunnerLauncher, RunnerLaunchObservation } from './runner-launcher.ts';
import type { AppleRunnerLifecycleOptions } from './runner-provider.ts';
import {
  advanceRunnerSessionState,
  RunnerCommandAccounting,
  type RunnerSession,
} from './runner-session-types.ts';
import { resolveRunnerLaunchReadinessMs, type RunnerStartBudget } from './runner-start-budget.ts';

export async function launchRunnerSession(
  device: DeviceInfo,
  launcher: RunnerLauncher,
  options: AppleRunnerLifecycleOptions,
  budget: RunnerStartBudget,
  admissionSignal: AbortSignal,
): Promise<RunnerSession> {
  const endpoint = { ...launcher.endpoint, token: mintRunnerToken() };
  const abort = new AbortController();
  const signal = budget.phase.signal
    ? AbortSignal.any([budget.phase.signal, admissionSignal])
    : admissionSignal;
  const cancel = () => abort.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  let launch;
  try {
    signal?.throwIfAborted();
    launch = await launcher.launch(endpoint, abort.signal);
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  const watch = {
    lost: false,
    ready: Promise.resolve(true),
    close() {
      this.lost = true;
    },
  };
  let termination: Promise<void> | undefined;
  const observation: RunnerLaunchObservation = {
    finished: launch.exited,
    exited: false,
    output: Promise.resolve(),
    isRunning: () => !observation.exited,
    waitForExit: (timeoutMs) => waitForRunnerLaunchExit(launch.exited, timeoutMs),
    cleanup: async () => {
      await observation.output;
      await flushRunnerLogAppends(logPath).catch((error: unknown) => {
        emitDiagnostic({
          level: 'warn',
          phase: 'ios_runner_log_flush_failed',
          data: { error: String(error), logPath },
        });
      });
    },
    readLogTail: (maxBytes) => output.slice(-maxBytes),
    earlyExitError: async (port, requestedLogPath) =>
      new AppError(
        'COMMAND_FAILED',
        'Runner did not accept connection (launcher exited early)',
        {
          reason: 'runner_process_exited',
          port,
          logPath: logPath ?? requestedLogPath,
          output: observation.readLogTail(16_384),
        },
        observation.failure,
      ),
    terminate: () =>
      (termination ??= (async () => {
        if (!observation.exited) await launch.terminate();
        await launch.exited.catch(() => {});
      })().catch((error: unknown) => {
        termination = undefined;
        throw new AppError(
          'COMMAND_FAILED',
          'Runner launcher could not terminate its generation',
          {
            reason: 'runner_termination_failed',
            deviceId: device.id,
          },
          error,
        );
      })),
  };
  let output = '';
  const logPath = resolveRunnerLaunchLogPath(options.logPath, device.id);
  const session: RunnerSession = {
    sessionId: randomUUID(),
    device,
    deviceId: device.id,
    endpoint,
    state: 'starting',
    commandCharges: new RunnerCommandAccounting(),
    speculative: options.speculative,
    launch: observation,
    listenerWatch: watch,
    runnerLogPath: logPath,
    launchDeadline: Deadline.fromTimeoutMs(resolveRunnerLaunchReadinessMs(budget)),
  };
  const settled = (failure?: unknown) => {
    observation.exited = true;
    observation.failure = failure;
    watch.close();
    session.retention?.cancel();
  };
  void launch.exited.then(() => settled(), settled);
  observation.output = (async () => {
    for await (const text of launch.output) {
      output = (output + text).slice(-16_384);
      logChunk(text, logPath, options.traceLogPath, options.verbose);
    }
  })().catch(async (error: unknown) => {
    observation.failure = error;
    advanceRunnerSessionState(session, 'draining');
    watch.close();
    session.retention?.cancel();
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_output_failed',
      data: { error: String(error), deviceId: device.id },
    });
    await observation.terminate().catch((terminationError: unknown) => {
      emitDiagnostic({
        level: 'warn',
        phase: 'ios_runner_termination_failed',
        data: { deviceId: device.id, error: String(terminationError) },
      });
    });
  });
  return session;
}

export async function refuseFailedRunnerPublication(session: RunnerSession): Promise<void> {
  if (session.state !== 'draining') return;
  await disposeRunnerSession(session, { graceful: false });
  throw new AppError(
    'COMMAND_FAILED',
    'Runner output failed during startup',
    { reason: 'runner_output_failed', deviceId: session.deviceId },
    session.launch.failure,
  );
}
