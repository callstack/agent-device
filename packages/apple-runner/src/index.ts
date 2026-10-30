/**
 * @agent-device/apple-runner - the Apple XCUITest runner client.
 *
 * The package entry names its whole surface. Host-bound operations evaluate the implementation, so
 * they reach their host capabilities through the `AppleRunnerHost` port, which `platform-apple`
 * binds once through `bindAppleRunnerHost` before any operation runs. The one operation outside
 * this closure, `runApplePressSeries`, and the legacy device-set restore stay behind function-scoped
 * imports so the entry evaluates only what a host-bound operation needs.
 */

export {
  bindAppleRunnerHost,
  type AppleRunnerHost,
  type RunnerDeviceClaimAuthorityProbe,
} from './host.ts';
export type {
  IosDeveloperDiskImageState,
  IosDeveloperModeState,
  IosDeviceReadiness,
  IosDeviceReadinessRemedies,
  IosPhysicalDeviceBackend,
  IosPhysicalDeviceRunnerControl,
} from './runner-physical-device.ts';
export {
  RUNNER_READY_PREFLIGHT_TIMEOUT_MS,
  SCROLL_KEYBOARD_OCCLUDES_SURFACE_RUNNER_CODE,
  buildRunnerSequenceCommand,
  parseRunnerSequenceResult,
  type RunnerCommand,
} from './runner-contract.ts';
export { isRunnerMainThreadTimeoutError } from './runner-error-classification.ts';
export {
  withAppleRunnerProvider,
  type AppleRunnerCommandExecutor,
  type AppleRunnerCommandOptions,
  type AppleRunnerProvider,
} from './runner-provider.ts';
export {
  requireRunnerBuildSettingsMatchBuildLog,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerArchBuildSettings,
  resolveRunnerBundleBuildSettings,
  resolveRunnerContainerBundleIds,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveRunnerSigningBuildSettings,
} from './runner-cache-metadata.ts';
export {
  SHARED_FOREGROUND_GEOMETRY_HEADER_FILENAME,
  resolveRunnerDerivedOverride,
} from './apple-runner-platform.ts';
export {
  requireCertifiedRunnerCacheArtifacts,
  writeRunnerCacheMetadataForArtifacts,
} from './runner-cache.ts';
export { findXctestrun as findRunnerXctestrun } from './runner-artifact.ts';
export { resolveExistingXctestrunProductPaths as resolveExistingRunnerProductPaths } from './runner-xctestrun-products.ts';
export { hasCachedAppleRunnerArtifact, resolveRunnerAppBundleId } from './runner-xctestrun.ts';
export { applyXctestRunnerAppIconFromDerivedPath } from './runner-icon.ts';
export { runnerLeaseCleanupAdapter } from './runner-disposal.ts';
export {
  cleanupRunnerLeasesForOwner,
  readStaleRunnerLease,
  verifyLeaseRunnerPidIdentity,
} from './runner-lease.ts';
export {
  detachIosRunnerSessionsForShutdown,
  readRunnerSessionLiveness,
  releaseIosRunnerOnClose,
  stopAllIosRunnerSessions,
  stopIosRunnerSession,
} from './runner-session.ts';

import type * as LegacyXctestDeviceSet from './legacy-xctest-device-set.ts';
import type * as RunnerSequence from './runner-sequence.ts';
import { retryWithPolicy, emitDiagnostic, hasScopedAppleToolProvider } from './host.ts';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import {
  ensureRunnerSession,
  readRunnerSessionLiveness,
  stopIosRunnerSession,
  validateRunnerDevice,
  releaseSpeculativeIosRunnerSession,
} from './runner-session.ts';
import {
  assertRunnerRequestActive,
  callerDeadlineExpired,
  resolveRunnerRequestSignal,
  withRunnerCommandId,
  type RunnerCommand,
} from './runner-contract.ts';
import { isRetryableRunnerError, isRunnerBusyError } from './runner-error-classification.ts';
import { isReadOnlyRunnerCommand } from './runner-command-traits.ts';
import {
  createLocalAppleRunnerProvider,
  resolveAppleRunnerProvider,
  type AppleRunnerCommandOptions,
  type AppleRunnerPrewarmOptions,
  type AppleRunnerProvider,
} from './runner-provider.ts';
import { createRunnerPhaseBudget, ensureXctestrunArtifact } from './runner-xctestrun.ts';
import {
  executeRunnerCommand,
  prepareLocalIosRunner,
  type PrepareIosRunnerOptions,
  type PrepareIosRunnerResult,
} from './runner-lifecycle.ts';
import { RUNNER_COMMAND_TIMEOUT_MS } from './runner-transport.ts';

// --- Runner command execution ---

/**
 * Attempts a read-only command may spend on one error class; 1 means no resend. A `RUNNER_BUSY`
 * refusal is the runner refusing fast on purpose while it drains abandoned XCTest work (#1105), so
 * that budget has to outlast the drain. The window is a heuristic, not a measurement: 200ms doubling
 * to a 1s cap, no jitter, is 5.4s of delay across eight attempts before round trips, and a drain
 * that outlives it still surfaces as `RUNNER_BUSY` (the runner's own `abandonedForSeconds=` marker
 * in runner.log is the evidence for tuning it). Transport failures keep the pre-existing three
 * attempts. The budget is positional: the error on each attempt sets how many attempts the loop may
 * reach in total, so three busy refusals followed by a transport failure resend no further.
 */
const RUNNER_BUSY_RESEND_ATTEMPTS = 8;
const TRANSPORT_RESEND_ATTEMPTS = 3;
const READ_ONLY_RESEND_POLICY = {
  maxAttempts: RUNNER_BUSY_RESEND_ATTEMPTS,
  baseDelayMs: 200,
  maxDelayMs: 1_000,
  jitter: 0,
};

function readOnlyResendBudget(error: unknown): number {
  if (isRunnerBusyError(error)) return RUNNER_BUSY_RESEND_ATTEMPTS;
  return isRetryableRunnerError(error) ? TRANSPORT_RESEND_ATTEMPTS : 1;
}

export async function runAppleRunnerCommand(
  device: DeviceInfo,
  command: RunnerCommand,
  options: AppleRunnerCommandOptions = {},
): Promise<Record<string, unknown>> {
  validateRunnerDevice(device);
  assertRunnerRequestActive(options.requestId);
  const runnerCommand = withRunnerCommandId(command);
  const provider = resolveAppleRunnerRuntime(device, options);
  if (!isReadOnlyRunnerCommand(runnerCommand)) {
    return provider.runCommand(device, runnerCommand, options);
  }
  let lastBusyRefusal: unknown;
  try {
    return await retryWithPolicy(
      () => {
        assertRunnerRequestActive(options.requestId);
        return provider.runCommand(device, runnerCommand, options);
      },
      {
        ...READ_ONLY_RESEND_POLICY,
        shouldRetry: (error, attempt) => {
          assertRunnerRequestActive(options.requestId);
          if (isRunnerBusyError(error)) lastBusyRefusal = error;
          return attempt < readOnlyResendBudget(error);
        },
      },
      // The busy window is seconds long, so an abort must wake the delay instead of sleeping it
      // out and sending one more attempt.
      { signal: resolveRunnerRequestSignal(options) },
    );
  } catch (error) {
    // A caller's deadline (a `wait` poll bounding this capture) that lands mid-window still has an
    // answer: the runner refused, and that typed refusal is what the caller can act on. Only a
    // cancelled request reports as a bare cancellation.
    if (lastBusyRefusal && callerDeadlineExpired(options)) throw lastBusyRefusal;
    throw error;
  }
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

/** Speculative host build: a request whose Apple tooling a provider serves has none to warm. */
export function prewarmAppleRunnerCache(
  device: DeviceInfo,
  options: PrewarmIosRunnerOptions = {},
): Promise<void> | undefined {
  if (!isIosFamily(device)) {
    return undefined;
  }
  if (hasScopedAppleToolProvider()) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_cache_prewarm_unavailable',
      data: { deviceId: device.id },
    });
    return undefined;
  }
  return runBestEffortIosRunnerPrewarm({
    device,
    options,
    failurePhase: 'ios_runner_cache_prewarm_failed',
    task: async (runnerOptions) => {
      // A cache prewarm owns the build phase it starts: one budget for the
      // `xcodebuild` the cache decision may call for.
      await ensureXctestrunArtifact(device, {
        ...runnerOptions,
        budget: createRunnerPhaseBudget(runnerOptions.buildTimeoutMs, runnerOptions.signal),
      });
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
  return resolveAppleRunnerProvider(device, LOCAL_APPLE_RUNNER_RUNTIME, {
    requestId: options.requestId,
  });
}

/**
 * Whether asking this device's runner now would be answered without a startup wait. Only a
 * session in the `ready` state counts: one that is registered but has not answered yet is still
 * starting, so sending it a command would queue behind its connection retries, and one already
 * going away would be asked to work while it is being taken down. Observation paths use this to
 * stay runner-free until the runner is ready.
 */
export function hasLiveIosRunnerSession(
  device: DeviceInfo,
  options: { requestId?: string } = {},
): boolean {
  if (!isIosFamily(device)) return false;
  return resolveAppleRunnerRuntime(device, options).hasLiveSession(device);
}

/** Releases the runner a prewarm started for `device` if no command has used it; false otherwise. */
export async function releaseSpeculativeIosRunnerSessionFor(
  device: DeviceInfo,
  options: { requestId?: string } = {},
): Promise<boolean> {
  if (!isIosFamily(device)) return false;
  const release = resolveAppleRunnerRuntime(device, options).releaseSpeculativeSession;
  return release ? await release(device) : false;
}

const LOCAL_APPLE_RUNNER_RUNTIME = createLocalAppleRunnerProvider(executeRunnerCommand, {
  prepare: prepareLocalIosRunner,
  hasLiveSession: (device) => readRunnerSessionLiveness(device.id)?.liveness === 'ready',
  releaseSpeculativeSession: async (device) => await releaseSpeculativeIosRunnerSession(device.id),
  prewarm: async (device, options) => {
    const { healthCheck, ...runnerOptions } = options;
    if (healthCheck === false) {
      await ensureRunnerSession(device, { ...runnerOptions, speculative: true });
      return;
    }
    await prepareLocalIosRunner(device, {
      ...runnerOptions,
      speculative: true,
      healthTimeoutMs: RUNNER_COMMAND_TIMEOUT_MS,
    });
  },
});

/**
 * A press series runs through the sequence driver, which stays outside the entry's eager closure
 * until a series is requested.
 */
export async function runApplePressSeries(
  ...args: Parameters<typeof RunnerSequence.runApplePressSeries>
): Promise<Record<string, unknown>> {
  const { runApplePressSeries: run } = await import('./runner-sequence.ts');
  return await run(...args);
}

/** Restores a legacy XCTest device-set redirect; the parser module loads on first use. */
export async function restoreLegacyXctestDeviceSetRedirect(
  ...args: Parameters<typeof LegacyXctestDeviceSet.restoreLegacyXctestDeviceSetRedirect>
): Promise<void> {
  const { restoreLegacyXctestDeviceSetRedirect: restore } =
    await import('./legacy-xctest-device-set.ts');
  restore(...args);
}
