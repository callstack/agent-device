import { withRetry } from '../../../../utils/retry.ts';
import { isIosFamily, type DeviceInfo } from '../../../../kernel/device.ts';
import { emitDiagnostic } from '../../../../utils/diagnostics.ts';
import { type RunnerSessionOptions, validateRunnerDevice } from './runner-session.ts';
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
export {
  isRetryableRunnerError,
  resolveRunnerEarlyExitHint,
  resolveRunnerBuildFailureHint,
  shouldRetryRunnerConnectError,
  type RunnerCommand,
} from './runner-contract.ts';
export type { PrepareIosRunnerOptions, PrepareIosRunnerResult } from './runner-lifecycle.ts';

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
    return withRetry(
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

type PrewarmIosRunnerOptions = RunnerSessionOptions & {
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
  task: (options: RunnerSessionOptions) => Promise<void>;
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
    await prepareLocalIosRunner(device, {
      ...options,
      healthTimeoutMs: RUNNER_COMMAND_TIMEOUT_MS,
    });
  },
});

export {
  resolveRunnerDestination,
  resolveRunnerBuildDestination,
  resolveRunnerMaxConcurrentDestinationsFlag,
  resolveRunnerAppBundleId,
  resolveRunnerSigningBuildSettings,
  resolveRunnerBundleBuildSettings,
  assertSafeDerivedCleanup,
  IOS_RUNNER_CONTAINER_BUNDLE_IDS,
} from './runner-xctestrun.ts';

export {
  detachIosSimulatorRunnerSessionsForShutdown,
  getRunnerSessionSnapshot,
  stopIosRunnerSession,
  abortAllIosRunnerSessions,
  stopAllIosRunnerSessions,
} from './runner-session.ts';
