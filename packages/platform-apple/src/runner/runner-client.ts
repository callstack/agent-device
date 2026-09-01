import { retryWithPolicy, emitDiagnostic } from './host.ts';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import {
  ensureRunnerSession,
  stopIosRunnerSession,
  validateRunnerDevice,
} from './runner-session.ts';
import {
  assertRunnerRequestActive,
  isRetryableRunnerError,
  withRunnerCommandId,
  type RunnerCommand,
} from './runner-contract.ts';
import { isReadOnlyRunnerCommand } from './runner-command-traits.ts';
import {
  createLocalAppleRunnerProvider,
  resolveAppleRunnerProvider,
  type AppleRunnerCommandOptions,
  type AppleRunnerPrewarmOptions,
  type AppleRunnerProvider,
} from './runner-provider.ts';
import { ensureXctestrunArtifact } from './runner-xctestrun.ts';
import {
  executeRunnerCommand,
  prepareLocalIosRunner,
  type PrepareIosRunnerOptions,
  type PrepareIosRunnerResult,
} from './runner-lifecycle.ts';
import { RUNNER_COMMAND_TIMEOUT_MS } from './runner-transport.ts';

// --- Runner command execution ---

export async function runAppleRunnerCommand(
  device: DeviceInfo,
  command: RunnerCommand,
  options: AppleRunnerCommandOptions = {},
): Promise<Record<string, unknown>> {
  validateRunnerDevice(device);
  assertRunnerRequestActive(options.requestId);
  const runnerCommand = withRunnerCommandId(command);
  const provider = resolveAppleRunnerRuntime(device, options);
  if (isReadOnlyRunnerCommand(runnerCommand.command)) {
    return retryWithPolicy(
      () => {
        assertRunnerRequestActive(options.requestId);
        return provider.runCommand(device, runnerCommand, options);
      },
      {
        shouldRetry: (error) => {
          assertRunnerRequestActive(options.requestId);
          return isRetryableRunnerError(error);
        },
      },
    );
  }
  return provider.runCommand(device, runnerCommand, options);
}

export async function notifyIosRunnerAppRelaunched(
  device: DeviceInfo,
  options: AppleRunnerCommandOptions = {},
): Promise<void> {
  if (!isIosFamily(device)) return;
  try {
    await runAppleRunnerCommand(device, { command: 'targetReset' }, options);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_target_reset_failed',
      data: { deviceId: device.id, error: error instanceof Error ? error.message : String(error) },
    });
    await stopIosRunnerSession(device.id);
  }
}

type PrewarmIosRunnerOptions = AppleRunnerPrewarmOptions & {
  propagateError?: boolean;
};

export function prewarmAppleRunnerCache(
  device: DeviceInfo,
  options: PrewarmIosRunnerOptions = {},
): Promise<void> | undefined {
  if (!isIosFamily(device)) {
    return undefined;
  }
  return runBestEffortIosRunnerPrewarm({
    device,
    options,
    failurePhase: 'ios_runner_cache_prewarm_failed',
    task: async (runnerOptions) => {
      await ensureXctestrunArtifact(device, runnerOptions);
    },
  });
}

export function prewarmIosRunnerSession(
  device: DeviceInfo,
  options: PrewarmIosRunnerOptions = {},
): Promise<void> | undefined {
  if (!isIosFamily(device)) {
    return undefined;
  }
  const provider = resolveAppleRunnerRuntime(device, options);
  const prewarmRunner = provider.prewarm;
  if (!prewarmRunner) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_session_prewarm_unavailable',
      data: { deviceId: device.id },
    });
    return undefined;
  }
  return runBestEffortIosRunnerPrewarm({
    device,
    options,
    failurePhase: 'ios_runner_session_prewarm_failed',
    task: async (taskOptions) => {
      await prewarmRunner(device, taskOptions);
    },
  });
}

function runBestEffortIosRunnerPrewarm(params: {
  device: DeviceInfo;
  options: PrewarmIosRunnerOptions;
  failurePhase: 'ios_runner_cache_prewarm_failed' | 'ios_runner_session_prewarm_failed';
  task: (options: AppleRunnerPrewarmOptions) => Promise<void>;
}): Promise<void> {
  const { device, options, failurePhase, task } = params;
  const { propagateError = false, ...runnerOptions } = options;
  const prewarm = task(runnerOptions).catch((error: unknown) => {
    emitDiagnostic({
      level: 'warn',
      phase: failurePhase,
      data: {
        deviceId: device.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    if (propagateError) {
      throw error;
    }
  });
  void prewarm;
  return prewarm;
}

export async function prepareIosRunner(
  device: DeviceInfo,
  options: PrepareIosRunnerOptions,
): Promise<PrepareIosRunnerResult> {
  validateRunnerDevice(device);
  assertRunnerRequestActive(options.requestId);
  const command = withRunnerCommandId({ command: 'uptime' });
  const provider = resolveAppleRunnerRuntime(device, options);
  if (provider.prepare) {
    return await provider.prepare(device, options);
  }

  const healthStartedAt = Date.now();
  const runner = await provider.runCommand(device, command, options);
  return {
    runner,
    connectMs: 0,
    healthCheckMs: Math.max(0, Date.now() - healthStartedAt),
  };
}

function resolveAppleRunnerRuntime(
  device: DeviceInfo,
  options: { requestId?: string },
): AppleRunnerProvider {
  return resolveAppleRunnerProvider(device, LOCAL_APPLE_RUNNER_RUNTIME, undefined, {
    requestId: options.requestId,
  });
}

const LOCAL_APPLE_RUNNER_RUNTIME = createLocalAppleRunnerProvider(executeRunnerCommand, {
  prepare: prepareLocalIosRunner,
  prewarm: async (device, options) => {
    const { healthCheck, ...runnerOptions } = options;
    if (healthCheck === false) {
      await ensureRunnerSession(device, runnerOptions);
      return;
    }
    await prepareLocalIosRunner(device, {
      ...runnerOptions,
      healthTimeoutMs: RUNNER_COMMAND_TIMEOUT_MS,
    });
  },
});
