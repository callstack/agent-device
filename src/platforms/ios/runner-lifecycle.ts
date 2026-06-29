import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { getRequestSignal, isRequestCanceledError } from '../../daemon/request-cancel.ts';
import { RUNNER_COMMAND_TIMEOUT_MS, RUNNER_STARTUP_TIMEOUT_MS } from './runner-transport.ts';
import {
  type RunnerSession,
  ensureRunnerSession,
  invalidateRunnerSession,
  executeRunnerCommandWithSession,
  readRunnerStartupTimeoutMs,
} from './runner-session.ts';
import {
  assertRunnerRequestActive,
  isRetryableRunnerError,
  shouldRetryRunnerConnectError,
  withRunnerCommandId,
  type RunnerCommand,
} from './runner-contract.ts';
import type {
  AppleRunnerCommandOptions,
  AppleRunnerPrepareOptions,
  AppleRunnerPrepareResult,
} from './runner-provider.ts';
import { markRunnerXctestrunArtifactBadForRun } from './runner-xctestrun.ts';
import { handleRunnerTransportErrorAfterCommandSend } from './runner-command-recovery.ts';

export type PrepareIosRunnerOptions = AppleRunnerPrepareOptions;
export type PrepareIosRunnerResult = AppleRunnerPrepareResult;

const PREPARE_RUNNER_HEALTH_MAX_SESSION_ATTEMPTS = 2;

export async function prepareLocalIosRunner(
  device: DeviceInfo,
  options: PrepareIosRunnerOptions,
): Promise<PrepareIosRunnerResult> {
  assertRunnerRequestActive(options.requestId);
  const signal = getRequestSignal(options.requestId);
  const command = withRunnerCommandId({ command: 'uptime' });
  let recoveryReason: string | undefined;
  for (let attempt = 1; attempt <= PREPARE_RUNNER_HEALTH_MAX_SESSION_ATTEMPTS; attempt += 1) {
    const result = await runPrepareAttempt({
      device,
      command,
      options,
      signal,
      attempt,
      recoveryReason,
    });
    if (result.kind === 'prepared') return result.result;
    recoveryReason = result.recoveryReason;
  }

  // Unreachable while PREPARE_RUNNER_HEALTH_MAX_SESSION_ATTEMPTS is positive.
  throw new AppError('COMMAND_FAILED', 'iOS runner prepare failed');
}

type PrepareAttemptResult =
  | { kind: 'prepared'; result: PrepareIosRunnerResult }
  | { kind: 'retry'; recoveryReason: string };

async function runPrepareAttempt(params: {
  device: DeviceInfo;
  command: RunnerCommand;
  options: PrepareIosRunnerOptions;
  signal: AbortSignal | undefined;
  attempt: number;
  recoveryReason: string | undefined;
}): Promise<PrepareAttemptResult> {
  const { device, command, options, signal, attempt, recoveryReason } = params;
  const connectStartedAt = Date.now();
  const session = await ensureRunnerSession(device, {
    ...options,
    cleanStaleBundles: attempt > 1 ? true : options.cleanStaleBundles,
  });
  const connectMs = Date.now() - connectStartedAt;
  try {
    const result = await runPrepareHealthCheck(
      device,
      session,
      command,
      options,
      signal,
      connectMs,
      {
        recoveryReason,
      },
    );
    return { kind: 'prepared', result: recordPrepareResult(device, result) };
  } catch (error) {
    return await handlePrepareHealthFailure({
      device,
      session,
      command,
      options,
      signal,
      attempt,
      error,
    });
  }
}

async function handlePrepareHealthFailure(params: {
  device: DeviceInfo;
  session: RunnerSession;
  command: RunnerCommand;
  options: PrepareIosRunnerOptions;
  signal: AbortSignal | undefined;
  attempt: number;
  error: unknown;
}): Promise<PrepareAttemptResult> {
  const { device, session, command, options, signal, attempt, error } = params;
  const appErr = error instanceof AppError ? error : new AppError('COMMAND_FAILED', String(error));
  if (attempt === 1 && shouldRecoverBadCachedRunnerArtifact(appErr, session)) {
    return {
      kind: 'prepared',
      result: await recoverBadCachedRunnerArtifact({
        device,
        session,
        command,
        options,
        signal,
        error: appErr,
      }),
    };
  }
  if (!shouldRetryPrepareRunnerHealthFailure(appErr)) {
    throw error;
  }
  const reason = appErr.message || 'runner_health_failed';
  if (attempt >= PREPARE_RUNNER_HEALTH_MAX_SESSION_ATTEMPTS) {
    await invalidateRunnerSessionBestEffort(session, 'prepare_runner_health_failed');
    throw error;
  }

  assertRunnerRequestActive(options.requestId);
  await invalidateRunnerSession(session, 'prepare_runner_health_retry');
  emitDiagnostic({
    level: 'warn',
    phase: 'ios_runner_prepare_health_retry',
    data: {
      command: command.command,
      commandId: command.commandId,
      sessionId: session.sessionId,
      attempt,
      maxAttempts: PREPARE_RUNNER_HEALTH_MAX_SESSION_ATTEMPTS,
      reason,
    },
  });
  return { kind: 'retry', recoveryReason: reason };
}

async function recoverBadCachedRunnerArtifact(params: {
  device: DeviceInfo;
  session: RunnerSession & {
    xctestrunArtifact: NonNullable<RunnerSession['xctestrunArtifact']>;
  };
  command: RunnerCommand;
  options: PrepareIosRunnerOptions;
  signal: AbortSignal | undefined;
  error: AppError;
}): Promise<PrepareIosRunnerResult> {
  const { device, session, command, options, signal, error } = params;
  const reason = error.message || 'runner_health_failed';
  await invalidateRunnerSession(session, 'prepare_cached_runner_health_failed');
  await markRunnerXctestrunArtifactBadForRun(session.xctestrunArtifact, reason);
  const connectStartedAt = Date.now();
  const rebuiltSession = await ensureRunnerSession(device, {
    ...options,
    cleanStaleBundles: true,
    forceRunnerXctestrunRebuild: true,
  });
  const connectMs = Date.now() - connectStartedAt;
  try {
    const recovered = await runPrepareHealthCheck(
      device,
      rebuiltSession,
      command,
      options,
      signal,
      connectMs,
      { recoveryReason: reason },
    );
    emitDiagnostic({
      level: 'info',
      phase: 'ios_runner_prepare_bad_cache_recovered',
      data: {
        command: command.command,
        commandId: command.commandId,
        sessionId: rebuiltSession.sessionId,
        xctestrunPath: rebuiltSession.xctestrunArtifact?.xctestrunPath,
        reason,
      },
    });
    return recordPrepareResult(device, recovered);
  } catch (retryErr) {
    await invalidateRunnerSessionBestEffort(rebuiltSession, 'prepare_rebuilt_runner_health_failed');
    const wrapped = wrapPrepareHealthFailure(retryErr, rebuiltSession, reason);
    emitPrepareDiagnostic(device, {
      cache: rebuiltSession.xctestrunArtifact?.cache,
      artifact: rebuiltSession.xctestrunArtifact?.artifact,
      buildMs: rebuiltSession.xctestrunArtifact?.buildMs,
      connectMs,
      healthCheckMs: 0,
      xctestrunPath: rebuiltSession.xctestrunArtifact?.xctestrunPath,
      failureReason: wrapped.message,
    });
    throw wrapped;
  }
}

async function invalidateRunnerSessionBestEffort(
  session: RunnerSession,
  reason: Parameters<typeof invalidateRunnerSession>[1],
): Promise<void> {
  try {
    await invalidateRunnerSession(session, reason);
  } catch {}
}

function shouldRetryPrepareRunnerHealthFailure(error: AppError): boolean {
  if (isRequestCanceledError(error)) return false;
  return (
    isRetryableRunnerError(error) ||
    shouldRetryRunnerConnectError(error) ||
    isPrepareHealthTimeout(error)
  );
}

// fallow-ignore-next-line complexity
export async function executeRunnerCommand(
  device: DeviceInfo,
  command: RunnerCommand,
  options: AppleRunnerCommandOptions,
): Promise<Record<string, unknown>> {
  assertRunnerRequestActive(options.requestId);
  const signal = getRequestSignal(options.requestId);
  let session: RunnerSession | undefined;
  try {
    session = await ensureRunnerSession(device, options);
    const timeoutMs = session.ready
      ? RUNNER_COMMAND_TIMEOUT_MS
      : readRunnerStartupTimeoutMs(session);
    return await executeRunnerCommandWithSession(
      device,
      session,
      command,
      options.logPath,
      timeoutMs,
      signal,
    );
  } catch (err) {
    const appErr = err instanceof AppError ? err : new AppError('COMMAND_FAILED', String(err));
    if (
      appErr.code === 'COMMAND_FAILED' &&
      typeof appErr.message === 'string' &&
      appErr.message.includes('Runner did not accept connection') &&
      shouldRetryRunnerConnectError(appErr) &&
      session
    ) {
      assertRunnerRequestActive(options.requestId);
      return await restartSessionAndRunCommand({
        device,
        session,
        command,
        options,
        signal,
        restartReason: 'runner_connect_failed_before_command_send',
      });
    }
    if (session && shouldRestartAfterReadinessPreflightError(appErr)) {
      assertRunnerRequestActive(options.requestId);
      return await restartSessionAndRunCommand({
        device,
        session,
        command,
        options,
        signal,
        restartReason: 'runner_readiness_preflight_failed_before_command_send',
        recoveredDiagnosticPhase: 'ios_runner_readiness_preflight_recovered',
      });
    }
    if (session && isRetryableRunnerError(appErr)) {
      return await handleRunnerTransportErrorAfterCommandSend({
        device,
        session,
        command,
        transportError: appErr,
        options,
        signal,
        invalidationReason: 'transport_error_after_command_send',
        invalidateSession: invalidateRunnerSession,
      });
    }
    throw err;
  }
}

async function restartSessionAndRunCommand(params: {
  device: DeviceInfo;
  session: RunnerSession;
  command: RunnerCommand;
  options: AppleRunnerCommandOptions;
  signal: AbortSignal | undefined;
  restartReason:
    | 'runner_connect_failed_before_command_send'
    | 'runner_readiness_preflight_failed_before_command_send';
  recoveredDiagnosticPhase?: string;
}): Promise<Record<string, unknown>> {
  const { device, command, options, signal, restartReason } = params;
  await invalidateRunnerSession(params.session, restartReason);
  const restartedSession = await ensureRunnerSession(device, {
    ...options,
    cleanStaleBundles: true,
  });
  try {
    const recovered = await executeRunnerCommandWithSession(
      device,
      restartedSession,
      command,
      options.logPath,
      RUNNER_STARTUP_TIMEOUT_MS,
      signal,
    );
    if (params.recoveredDiagnosticPhase) {
      emitDiagnostic({
        level: 'debug',
        phase: params.recoveredDiagnosticPhase,
        data: {
          command: command.command,
          commandId: command.commandId,
          recovery: 'session_restarted',
          sessionId: restartedSession.sessionId,
        },
      });
    }
    return recovered;
  } catch (retryErr) {
    const retryAppErr =
      retryErr instanceof AppError ? retryErr : new AppError('COMMAND_FAILED', String(retryErr));
    if (isRetryableRunnerError(retryAppErr)) {
      return await handleRunnerTransportErrorAfterCommandSend({
        device,
        session: restartedSession,
        command,
        transportError: retryAppErr,
        options,
        signal,
        invalidationReason: 'transport_error_after_retry_command_send',
        invalidateSession: invalidateRunnerSession,
      });
    }
    throw retryErr;
  }
}

async function runPrepareHealthCheck(
  device: DeviceInfo,
  session: RunnerSession,
  command: RunnerCommand,
  options: PrepareIosRunnerOptions,
  signal: AbortSignal | undefined,
  connectMs: number,
  reason?: { recoveryReason?: string; failureReason?: string },
): Promise<PrepareIosRunnerResult> {
  const healthStartedAt = Date.now();
  const runner = await executeRunnerCommandWithSession(
    device,
    session,
    command,
    options.logPath,
    options.healthTimeoutMs,
    signal,
  );
  return buildPrepareIosRunnerResult(
    runner,
    session,
    connectMs,
    Date.now() - healthStartedAt,
    reason,
  );
}

function shouldRecoverBadCachedRunnerArtifact(
  error: AppError,
  session: RunnerSession,
): session is RunnerSession & {
  xctestrunArtifact: NonNullable<RunnerSession['xctestrunArtifact']>;
} {
  const artifact = session.xctestrunArtifact;
  if (!artifact || artifact.cache === 'miss') return false;
  return shouldRetryPrepareRunnerHealthFailure(error);
}

function isPrepareHealthTimeout(error: AppError): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('timeout') || message.includes('timed out') || message.includes('deadline')
  );
}

function wrapPrepareHealthFailure(
  error: unknown,
  session: RunnerSession,
  restoredFailureReason: string,
): AppError {
  const appErr = error instanceof AppError ? error : new AppError('COMMAND_FAILED', String(error));
  return new AppError(
    appErr.code,
    'artifact restored but runner did not connect',
    {
      ...(appErr.details ?? {}),
      restoredFailureReason,
      xctestrunPath: session.xctestrunArtifact?.xctestrunPath,
      artifact: session.xctestrunArtifact?.artifact,
      cache: session.xctestrunArtifact?.cache,
      reason: appErr.message,
    },
    appErr,
  );
}

function buildPrepareIosRunnerResult(
  runner: Record<string, unknown>,
  session: RunnerSession,
  connectMs: number,
  healthCheckMs: number,
  reason: { recoveryReason?: string; failureReason?: string } | undefined,
): PrepareIosRunnerResult {
  const artifact = session.xctestrunArtifact;
  const reasonFields = {
    ...(reason?.recoveryReason ? { recoveryReason: reason.recoveryReason } : {}),
    ...(reason?.failureReason ? { failureReason: reason.failureReason } : {}),
  };
  if (!artifact) {
    return {
      runner,
      connectMs: Math.max(0, connectMs),
      healthCheckMs: Math.max(0, healthCheckMs),
      ...reasonFields,
    };
  }
  return {
    runner,
    cache: artifact.cache,
    artifact: artifact.artifact,
    buildMs: artifact.buildMs,
    connectMs: Math.max(0, connectMs),
    healthCheckMs: Math.max(0, healthCheckMs),
    xctestrunPath: artifact.xctestrunPath,
    ...reasonFields,
  };
}

function recordPrepareResult(
  device: DeviceInfo,
  result: PrepareIosRunnerResult,
): PrepareIosRunnerResult {
  emitPrepareDiagnostic(device, result);
  return result;
}

function emitPrepareDiagnostic(
  device: DeviceInfo,
  result: Omit<PrepareIosRunnerResult, 'runner'>,
): void {
  emitDiagnostic({
    level: result.failureReason ? 'warn' : 'info',
    phase: 'apple_runner_prepare',
    data: {
      platform: device.platform,
      target: device.target,
      deviceId: device.id,
      cache: result.cache,
      artifact: result.artifact,
      buildMs: result.buildMs,
      connectMs: result.connectMs,
      healthCheckMs: result.healthCheckMs,
      xctestrunPath: result.xctestrunPath,
      recoveryReason: result.recoveryReason,
      failureReason: result.failureReason,
    },
  });
}

function isRunnerReadinessPreflightError(error: AppError): boolean {
  return error.details?.runnerReadinessPreflightFailed === true;
}

function shouldRestartAfterReadinessPreflightError(error: AppError): boolean {
  return (
    isRunnerReadinessPreflightError(error) &&
    (isRetryableRunnerError(error) || isRunnerReadinessPreflightTimeout(error))
  );
}

function isRunnerReadinessPreflightTimeout(error: AppError): boolean {
  const message = error.message.toLowerCase();
  return message.includes('timeout') || message.includes('timed out');
}
