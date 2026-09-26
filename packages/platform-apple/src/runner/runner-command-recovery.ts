import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from './host.ts';
import {
  classifyRunnerReportedError,
  decodeRunnerResponseBody,
  isRunnerResponseOk,
  readRunnerResponseData,
  type RunnerCommand,
  type RunnerResponsePayload,
} from './runner-contract.ts';
import { isReadOnlyRunnerCommand } from './runner-command-traits.ts';
import type { RunnerChargeSettlement } from './runner-session-types.ts';
import type { AppleRunnerCommandOptions } from './runner-provider.ts';
import { executeRunnerCommandWithSession, type RunnerSession } from './runner-session.ts';

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
  // Terminal evidence says the runner finished *this* command, so that command's abandoned charge pays
  // off and no other's does. `accepted`, `started`, and a state this daemon cannot name all keep the
  // charge: the command may still be executing, and a runner kept on the kill path is the safe answer.
  const charge = settleRunnerChargeForTerminalStatus(session, command, lifecycleState);
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_command_status_recovery',
    data: {
      command: command.command,
      commandId: command.commandId,
      lifecycleState,
      ...readinessPreflight,
      ...chargeSettlementDiagnostic(charge),
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

/**
 * The runner journal vocabulary, so the charge settlement below and the recovery verdict in
 * {@link handleRunnerCommandStatusRecovery} cannot disagree about what a state means.
 * `runner-swift-settlement-fixtures.ts` pins these names to `RunnerCommandLifecycleState`, and the
 * recovery wiring rows are derived from that same declaration, so a state the runner gains has to be
 * ruled here before it can decide a handoff.
 *
 * `completed` and `failed` close an entry — from the response's `ok` in `finish`, or a thrown error in
 * `fail` — so execution ended, and each gets its own recovery verdict below. `accepted` and `started`
 * are written as execution opens, so they share one in-flight verdict. `notAccepted` is what `status`
 * reports for an id the journal never held, which this daemon cannot read as terminal.
 */
const RUNNER_TERMINAL_LIFECYCLE_STATES: ReadonlySet<string> = new Set(['completed', 'failed']);
const RUNNER_IN_FLIGHT_LIFECYCLE_STATES: ReadonlySet<string> = new Set(['accepted', 'started']);

/**
 * Discharges the abandoned charge terminal status proves landed (#2965). A status reply is served
 * inline, so it is no evidence that queued work finished; this is the only place a status answer may
 * settle a charge, and only the one its `statusCommandId` names.
 */
function settleRunnerChargeForTerminalStatus(
  session: RunnerSession,
  command: RunnerCommand,
  lifecycleState: string,
): RunnerChargeSettlement | undefined {
  if (!RUNNER_TERMINAL_LIFECYCLE_STATES.has(lifecycleState)) return undefined;
  return session.commandCharges.settleTerminalEvidence(command.commandId);
}

function chargeSettlementDiagnostic(
  settlement: RunnerChargeSettlement | undefined,
): Record<string, unknown> {
  if (!settlement) return {};
  return {
    abandonedChargeSettled: settlement.settled,
    ...(settlement.refused ? { abandonedChargeRefused: settlement.refused } : {}),
  };
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

  if (RUNNER_IN_FLIGHT_LIFECYCLE_STATES.has(lifecycleState)) {
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
  if (isReadOnlyRunnerCommand(command)) {
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
  // The journal's code means exactly what the same code means on a live response, so read it with
  // the one classifier (#2484 follow-up): a `RUNNER_BUSY` recovered from the lifecycle journal must
  // stay `COMMAND_FAILED` + retriable, or a polling `wait` sees an unclassified failure and
  // surrenders its budget to a condition that clears on its own.
  const classification = classifyRunnerReportedError(errorCode);
  return new AppError(
    classification.code,
    errorMessage,
    {
      command: command.command,
      commandId: command.commandId,
      lifecycleState: 'failed',
      recovery: 'runner_reported_failure',
      ...classification.details,
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
  if (isReadOnlyRunnerCommand(command)) {
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
  let payload: RunnerResponsePayload;
  try {
    payload = decodeRunnerResponseBody(value);
  } catch {
    // A retained body the one decoder refuses is not a recoverable result; the
    // caller keeps the session and reports the retained response as unreadable
    // instead of returning a truncated command result (#2662).
    return undefined;
  }
  return isRunnerResponseOk(payload) ? readRunnerResponseData(payload) : undefined;
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
