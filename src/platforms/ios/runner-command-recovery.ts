import { AppError, toAppErrorCode } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { RunnerCommand } from './runner-contract.ts';
import { isReadOnlyRunnerCommand } from './runner-command-traits.ts';
import type { AppleRunnerCommandOptions } from './runner-provider.ts';
import { executeRunnerCommandWithSession, type RunnerSession } from './runner-session.ts';

type LifecycleResponsePayload = {
  ok?: unknown;
  data?: unknown;
};

type RunnerTransportRecovery =
  | { type: 'recovered'; data: Record<string, unknown>; reason: string; lifecycleState?: string }
  | { type: 'skipInvalidation'; error: AppError; reason: string; lifecycleState?: string }
  | { type: 'retainInvalidation'; error?: AppError; reason: string; lifecycleState?: string };

type RunnerTransportRecoveryContext = {
  command: RunnerCommand;
  session: RunnerSession;
  transportError: AppError;
  invalidationReason: string;
  invalidateSession: (session: RunnerSession, reason: string) => Promise<void>;
};

type RunnerReadinessPreflightRecoveryDetails = {
  readinessPreflightSkipped?: boolean;
  readinessPreflightSkipReason?: string;
  readinessPreflightSkippedAgeMs?: number;
};

const RUNNER_STATUS_RECOVERY_TIMEOUT_MS = 3_000;

export async function handleRunnerTransportErrorAfterCommandSend(params: {
  device: DeviceInfo;
  session: RunnerSession;
  command: RunnerCommand;
  transportError: AppError;
  options: AppleRunnerCommandOptions;
  signal: AbortSignal | undefined;
  invalidationReason: string;
  invalidateSession: (session: RunnerSession, reason: string) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const { device, session, command, transportError, options, signal, invalidationReason } = params;
  const recovery = await tryRecoverRunnerCommandAfterTransportError(
    device,
    session,
    command,
    transportError,
    options,
    signal,
  );
  return await applyRunnerTransportRecovery(recovery, {
    command,
    session,
    transportError,
    invalidationReason,
    invalidateSession: params.invalidateSession,
  });
}

async function applyRunnerTransportRecovery(
  recovery: RunnerTransportRecovery | undefined,
  context: RunnerTransportRecoveryContext,
): Promise<Record<string, unknown>> {
  if (!recovery) return await retainRunnerInvalidation(context, 'status_recovery_unavailable');
  if (recovery.type === 'recovered') return recoverRunnerResponse(recovery, context);
  if (recovery.type === 'skipInvalidation') throw skipRunnerInvalidation(recovery, context);
  return await retainRunnerInvalidation(
    context,
    recovery.reason,
    recovery.lifecycleState,
    recovery.error,
  );
}

function recoverRunnerResponse(
  recovery: Extract<RunnerTransportRecovery, { type: 'recovered' }>,
  context: RunnerTransportRecoveryContext,
): Record<string, unknown> {
  emitRunnerInvalidationDecision({
    command: context.command,
    session: context.session,
    transportError: context.transportError,
    decision: 'skipped',
    reason: recovery.reason,
    lifecycleState: recovery.lifecycleState,
  });
  return recovery.data;
}

function skipRunnerInvalidation(
  recovery: Extract<RunnerTransportRecovery, { type: 'skipInvalidation' }>,
  context: RunnerTransportRecoveryContext,
): AppError {
  emitRunnerInvalidationDecision({
    command: context.command,
    session: context.session,
    transportError: context.transportError,
    decision: 'skipped',
    reason: recovery.reason,
    lifecycleState: recovery.lifecycleState,
  });
  return recovery.error;
}

async function retainRunnerInvalidation(
  context: RunnerTransportRecoveryContext,
  reason: string,
  lifecycleState?: string,
  error?: AppError,
): Promise<never> {
  emitRunnerInvalidationDecision({
    command: context.command,
    session: context.session,
    transportError: context.transportError,
    decision: 'retained',
    reason,
    lifecycleState,
  });
  await context.invalidateSession(context.session, context.invalidationReason);
  throw error ?? context.transportError;
}

async function tryRecoverRunnerCommandAfterTransportError(
  device: DeviceInfo,
  session: RunnerSession,
  command: RunnerCommand,
  transportError: AppError,
  options: AppleRunnerCommandOptions,
  signal?: AbortSignal,
): Promise<RunnerTransportRecovery | undefined> {
  if (command.command === 'status' || !command.commandId?.trim()) return undefined;
  const readinessPreflight = readReadinessPreflightRecoveryDetails(transportError);
  let status: Record<string, unknown>;
  try {
    status = await executeRunnerCommandWithSession(
      device,
      session,
      { command: 'status', statusCommandId: command.commandId },
      options.logPath,
      RUNNER_STATUS_RECOVERY_TIMEOUT_MS,
      signal,
    );
  } catch (error) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_command_status_recovery_failed',
      data: {
        command: command.command,
        commandId: command.commandId,
        error: error instanceof Error ? error.message : String(error),
        ...readinessPreflight,
      },
    });
    return { type: 'retainInvalidation', reason: 'status_probe_failed' };
  }

  const lifecycleState = typeof status.lifecycleState === 'string' ? status.lifecycleState : '';
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_command_status_recovery',
    data: {
      command: command.command,
      commandId: command.commandId,
      lifecycleState,
      ...readinessPreflight,
    },
  });
  return handleRunnerCommandStatusRecovery(
    status,
    lifecycleState,
    command,
    transportError,
    options,
  );
}

function handleRunnerCommandStatusRecovery(
  status: Record<string, unknown>,
  lifecycleState: string,
  command: RunnerCommand,
  transportError: AppError,
  options: AppleRunnerCommandOptions,
): RunnerTransportRecovery | undefined {
  if (lifecycleState === 'completed') {
    return handleCompletedRunnerStatus(status, command, transportError, options);
  }

  if (lifecycleState === 'failed') {
    return {
      type: 'skipInvalidation',
      reason: 'runner_reported_failure',
      lifecycleState,
      error: runnerStatusFailureError(status, command, transportError, options),
    };
  }

  if (lifecycleState === 'accepted' || lifecycleState === 'started') {
    return {
      type: 'skipInvalidation',
      reason: 'command_still_in_flight',
      lifecycleState,
      error: runnerStatusInFlightError(lifecycleState, command, transportError, options),
    };
  }

  return {
    type: 'retainInvalidation',
    reason: lifecycleState ? 'unknown_lifecycle_state' : 'missing_lifecycle_state',
    lifecycleState,
    error: new AppError(
      'COMMAND_FAILED',
      `Runner command "${command.command}" lost its transport response and lifecycle status was ${lifecycleState ? `"${lifecycleState}"` : 'missing'}, so agent-device invalidated the runner session instead of replaying the command.`,
      {
        command: command.command,
        commandId: command.commandId,
        lifecycleState,
        recovery: 'lifecycle_state_not_recoverable',
        hint: unknownLifecycleStateHint(command.command),
        logPath: options.logPath,
        transportError: transportError.message,
      },
      transportError,
    ),
  };
}

function handleCompletedRunnerStatus(
  status: Record<string, unknown>,
  command: RunnerCommand,
  transportError: AppError,
  options: AppleRunnerCommandOptions,
): RunnerTransportRecovery {
  const recovered = parseLifecycleResponseJson(status.lifecycleResponseJson);
  if (recovered) {
    return {
      type: 'recovered',
      data: recovered,
      reason: 'completed_with_retained_response',
      lifecycleState: 'completed',
    };
  }
  if (isReadOnlyRunnerCommand(command.command)) {
    return {
      type: 'skipInvalidation',
      error: transportError,
      reason: 'read_only_completed_without_retained_response',
      lifecycleState: 'completed',
    };
  }
  const readinessPreflight = readReadinessPreflightRecoveryDetails(transportError);
  return {
    type: 'skipInvalidation',
    reason: 'completed_without_retained_response',
    lifecycleState: 'completed',
    error: new AppError(
      'COMMAND_FAILED',
      `Runner command "${command.command}" completed after the transport response was lost, but no recoverable response was retained.`,
      {
        command: command.command,
        commandId: command.commandId,
        lifecycleState: 'completed',
        recovery: 'completed_without_retained_response',
        ...readinessPreflight,
        hint: completedWithoutRetainedResponseHint(command.command, readinessPreflight),
        logPath: options.logPath,
        transportError: transportError.message,
      },
      transportError,
    ),
  };
}

function runnerStatusFailureError(
  status: Record<string, unknown>,
  command: RunnerCommand,
  transportError: AppError,
  options: AppleRunnerCommandOptions,
): AppError {
  const errorCode =
    typeof status.lifecycleErrorCode === 'string' ? status.lifecycleErrorCode : undefined;
  const errorMessage =
    typeof status.lifecycleErrorMessage === 'string'
      ? status.lifecycleErrorMessage
      : 'Runner command failed';
  const hint =
    typeof status.lifecycleErrorHint === 'string' ? status.lifecycleErrorHint : undefined;
  const readinessPreflight = readReadinessPreflightRecoveryDetails(transportError);
  return new AppError(
    toAppErrorCode(errorCode),
    errorMessage,
    {
      command: command.command,
      commandId: command.commandId,
      lifecycleState: 'failed',
      recovery: 'runner_reported_failure',
      ...readinessPreflight,
      hint: hint ?? runnerReportedFailureHint(command.command, readinessPreflight),
      logPath: options.logPath,
      transportError: transportError.message,
    },
    transportError,
  );
}

function runnerStatusInFlightError(
  lifecycleState: string,
  command: RunnerCommand,
  transportError: AppError,
  options: AppleRunnerCommandOptions,
): AppError {
  if (isReadOnlyRunnerCommand(command.command)) {
    return transportError;
  }
  const readinessPreflight = readReadinessPreflightRecoveryDetails(transportError);
  return new AppError(
    'COMMAND_FAILED',
    `Runner command "${command.command}" is still ${lifecycleState} after the transport response was lost.`,
    {
      command: command.command,
      commandId: command.commandId,
      lifecycleState,
      recovery: 'command_still_in_flight',
      ...readinessPreflight,
      hint: inFlightAfterLostResponseHint(command.command, lifecycleState, readinessPreflight),
      logPath: options.logPath,
      transportError: transportError.message,
    },
    transportError,
  );
}

function parseLifecycleResponseJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = parseLifecycleResponsePayload(value);
  if (!parsed.ok) return undefined;
  if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
    return parsed.data as Record<string, unknown>;
  }
  return {};
}

function parseLifecycleResponsePayload(value: string): LifecycleResponsePayload {
  try {
    const raw: unknown = JSON.parse(value);
    if (raw && typeof raw === 'object') return raw as LifecycleResponsePayload;
  } catch {}
  return {};
}

function completedWithoutRetainedResponseHint(
  command: string,
  readinessPreflight: RunnerReadinessPreflightRecoveryDetails,
): string {
  return `${lostResponseReadinessContext(readinessPreflight)}The runner is still reachable and reports "${command}" already completed, so agent-device kept the session open and will not replay it. Run snapshot -i to inspect the current UI, then continue from that observed state.`;
}

function runnerReportedFailureHint(
  command: string,
  readinessPreflight: RunnerReadinessPreflightRecoveryDetails,
): string {
  return `${lostResponseReadinessContext(readinessPreflight)}The runner is still reachable and reports "${command}" failed after the transport response was lost, so agent-device kept the session open and did not replay it. Run snapshot -i to inspect the current UI and retry with a selector visible in that snapshot.`;
}

function inFlightAfterLostResponseHint(
  command: string,
  lifecycleState: string,
  readinessPreflight: RunnerReadinessPreflightRecoveryDetails,
): string {
  return `${lostResponseReadinessContext(readinessPreflight)}The runner is still reachable and reports "${command}" is ${lifecycleState}, so agent-device kept the session open and will not replay it. Wait briefly, run snapshot -i to inspect the current UI, then continue from that observed state.`;
}

function lostResponseReadinessContext(
  readinessPreflight: RunnerReadinessPreflightRecoveryDetails,
): string {
  if (readinessPreflight.readinessPreflightSkipped !== true) return '';
  return 'This hot command skipped the uptime preflight because the runner had just completed a healthy interaction; status recovery confirmed the runner still observed it. ';
}

function readBooleanDetail(error: AppError, key: string): boolean | undefined {
  const value = error.details?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readStringDetail(error: AppError, key: string): string | undefined {
  const value = error.details?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumberDetail(error: AppError, key: string): number | undefined {
  const value = error.details?.[key];
  return typeof value === 'number' ? value : undefined;
}

function readReadinessPreflightRecoveryDetails(
  error: AppError,
): RunnerReadinessPreflightRecoveryDetails {
  const details: RunnerReadinessPreflightRecoveryDetails = {};
  const skipped = readBooleanDetail(error, 'runnerReadinessPreflightSkipped');
  if (skipped !== undefined) details.readinessPreflightSkipped = skipped;
  const reason = readStringDetail(error, 'runnerReadinessPreflightSkipReason');
  if (reason !== undefined) details.readinessPreflightSkipReason = reason;
  const ageMs = readNumberDetail(error, 'runnerReadinessPreflightSkippedAgeMs');
  if (ageMs !== undefined) details.readinessPreflightSkippedAgeMs = ageMs;
  return details;
}

function unknownLifecycleStateHint(command: string): string {
  return `The runner did not confirm that "${command}" reached a safe terminal state, so agent-device kept the conservative invalidation path. Run snapshot -i before retrying if the UI may have changed.`;
}

function emitRunnerInvalidationDecision(params: {
  command: RunnerCommand;
  session: RunnerSession;
  transportError: AppError;
  decision: 'skipped' | 'retained';
  reason: string;
  lifecycleState?: string;
}): void {
  const { command, session, transportError, decision, reason, lifecycleState } = params;
  emitDiagnostic({
    level: decision === 'retained' ? 'warn' : 'debug',
    phase: 'ios_runner_command_invalidation_decision',
    data: {
      command: command.command,
      commandId: command.commandId,
      decision,
      reason,
      lifecycleState,
      runnerReachable: lifecycleState !== undefined,
      sessionId: session.sessionId,
      transportError: transportError.message,
    },
  });
}
