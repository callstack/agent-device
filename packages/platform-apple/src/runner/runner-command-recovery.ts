import { AppError, type DispatchDisclosure, discloseDispatch } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from './host.ts';
import {
  classifyRunnerReportedError,
  decodeRunnerResponseBody,
  isRunnerResponseOk,
  readRunnerResponseData,
  type RunnerCommand,
  type RunnerReportedErrorClass,
  type RunnerResponsePayload,
} from './runner-contract.ts';
import { isReadOnlyRunnerCommand } from './runner-command-traits.ts';
import { RUNNER_REPLY_LOST_REASON } from './runner-error-classification.ts';
import type { AppleRunnerCommandOptions } from './runner-provider.ts';
import { executeRunnerCommandWithSession, type RunnerSession } from './runner-session.ts';

type RunnerTransportRecovery =
  | { type: 'recovered'; data: Record<string, unknown>; reason: string; lifecycleState?: string }
  | ({
      type: 'skipInvalidation' | 'retainInvalidation';
      reason: string;
      lifecycleState?: string;
    } & RunnerRecoveryFailure);

/**
 * What a verdict that recovered no result fails with: the runner's own answer read back from its
 * journal, or a reply that stayed lost.
 */
type RunnerRecoveryFailure =
  | { runnerAnswer: AppError; dispatched: DispatchDisclosure }
  | { lostReply: LostReply };

/**
 * What status recovery learned about a command whose reply stayed lost. The message is never the
 * transport error's: classification rows match foreign transport text, and a lost reply must not
 * read as the retryable failure it wraps. `cause` completes the shared "lost its transport response
 * and ..." sentence; `message` is for the outcomes that do not fit it.
 */
type LostReply = Readonly<{
  recovery: string;
  lifecycleState?: string;
  hint: string;
}> &
  Readonly<{ cause: string } | { message: string }>;

type RunnerTransportRecoveryContext = {
  command: RunnerCommand;
  session: RunnerSession;
  transportError: AppError;
  options: AppleRunnerCommandOptions;
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
    options,
    invalidationReason,
    invalidateSession: params.invalidateSession,
  });
}

async function applyRunnerTransportRecovery(
  recovery: RunnerTransportRecovery,
  context: RunnerTransportRecoveryContext,
): Promise<Record<string, unknown>> {
  if (recovery.type === 'recovered') return recoverRunnerResponse(recovery, context);
  const failure = resolveRunnerRecoveryFailure(recovery, context);
  if (recovery.type === 'skipInvalidation') {
    throw skipRunnerInvalidation(recovery, context, failure);
  }
  return await retainRunnerInvalidation(recovery, context, failure);
}

/**
 * A lost reply fails a mutation as {@link RUNNER_REPLY_LOST_REASON}: it is not resent. A read keeps
 * the transport error, because `runAppleRunnerCommand` resends a read on exactly that error.
 */
function resolveRunnerRecoveryFailure(
  failure: RunnerRecoveryFailure,
  context: RunnerTransportRecoveryContext,
): AppError {
  if ('runnerAnswer' in failure) return discloseDispatch(failure.runnerAnswer, failure.dispatched);
  if (isReadOnlyRunnerCommand(context.command)) {
    return discloseDispatch(context.transportError, 'unknown');
  }
  return discloseDispatch(buildLostReplyError(context, failure.lostReply), 'unknown');
}

/**
 * The one shape of a mutation's lost-reply failure; the transport's own reason stays readable, and
 * its own hint wins because it names a cause (a boot failure, an unattached cable) the generic
 * lost-reply hint does not.
 */
function buildLostReplyError(
  context: RunnerTransportRecoveryContext,
  lostReply: LostReply,
): AppError {
  const { command, transportError, options } = context;
  const transportReason = transportError.details?.reason;
  const transportHint = transportError.details?.hint;
  return new AppError(
    'COMMAND_FAILED',
    'cause' in lostReply ? lostReplyMessage(command.command, lostReply.cause) : lostReply.message,
    {
      command: command.command,
      commandId: command.commandId,
      ...(lostReply.lifecycleState === undefined
        ? {}
        : { lifecycleState: lostReply.lifecycleState }),
      reason: RUNNER_REPLY_LOST_REASON,
      ...(transportReason === undefined ? {} : { transportReason }),
      recovery: lostReply.recovery,
      ...readReadinessPreflightRecoveryDetails(transportError),
      hint: typeof transportHint === 'string' ? transportHint : lostReply.hint,
      logPath: options.logPath ?? transportError.details?.logPath,
      transportError: transportError.message,
    },
    transportError,
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
  recovery: Exclude<RunnerTransportRecovery, { type: 'recovered' }>,
  context: RunnerTransportRecoveryContext,
  failure: AppError,
): AppError {
  emitRunnerInvalidationDecision({
    command: context.command,
    session: context.session,
    transportError: context.transportError,
    decision: 'skipped',
    reason: recovery.reason,
    lifecycleState: recovery.lifecycleState,
  });
  return failure;
}

async function retainRunnerInvalidation(
  recovery: Exclude<RunnerTransportRecovery, { type: 'recovered' }>,
  context: RunnerTransportRecoveryContext,
  failure: AppError,
): Promise<never> {
  emitRunnerInvalidationDecision({
    command: context.command,
    session: context.session,
    transportError: context.transportError,
    decision: 'retained',
    reason: recovery.reason,
    lifecycleState: recovery.lifecycleState,
  });
  await context.invalidateSession(context.session, context.invalidationReason);
  throw failure;
}

async function tryRecoverRunnerCommandAfterTransportError(
  device: DeviceInfo,
  session: RunnerSession,
  command: RunnerCommand,
  transportError: AppError,
  options: AppleRunnerCommandOptions,
  signal?: AbortSignal,
): Promise<RunnerTransportRecovery> {
  if (command.command === 'status' || !command.commandId?.trim()) {
    return {
      type: 'retainInvalidation',
      reason: 'status_recovery_unavailable',
      lostReply: {
        recovery: 'status_recovery_unavailable',
        cause: 'status recovery was unavailable',
        hint: unknownLifecycleStateHint(command.command),
      },
    };
  }
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
    return {
      type: 'retainInvalidation',
      reason: 'status_probe_failed',
      lostReply: {
        recovery: 'status_probe_failed',
        cause: 'the status probe failed',
        hint: unknownLifecycleStateHint(command.command),
      },
    };
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
      // Whether this terminal evidence discharged a debt. Absent when the state is not terminal, so
      // nothing was attempted; `false` when the command held no abandoned charge to pay.
      ...(charge === undefined ? {} : { abandonedChargeSettled: charge }),
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
 *
 * @returns whether the evidence paid a debt, or `undefined` when the state is not terminal and no
 *   settlement was attempted.
 */
function settleRunnerChargeForTerminalStatus(
  session: RunnerSession,
  command: RunnerCommand,
  lifecycleState: string,
): boolean | undefined {
  if (!RUNNER_TERMINAL_LIFECYCLE_STATES.has(lifecycleState)) return undefined;
  return session.commandCharges.settleTerminalEvidence(command.commandId);
}

function handleRunnerCommandStatusRecovery(
  status: Record<string, unknown>,
  lifecycleState: string,
  command: RunnerCommand,
  transportError: AppError,
  options: AppleRunnerCommandOptions,
): RunnerTransportRecovery {
  if (lifecycleState === 'completed') {
    return handleCompletedRunnerStatus(status, command, transportError);
  }

  if (lifecycleState === 'failed') {
    // The journal's code means exactly what the same code means on a live response, so read it with
    // the one classifier (#2484 follow-up): a `RUNNER_BUSY` recovered from the lifecycle journal must
    // stay `COMMAND_FAILED` + retriable, or a polling `wait` sees an unclassified failure and
    // surrenders its budget to a condition that clears on its own.
    const classification = classifyRunnerReportedError(
      typeof status.lifecycleErrorCode === 'string' ? status.lifecycleErrorCode : undefined,
    );
    return {
      type: 'skipInvalidation',
      reason: 'runner_reported_failure',
      lifecycleState,
      dispatched: classification.details.dispatched,
      runnerAnswer: runnerStatusFailureError(
        status,
        classification,
        command,
        transportError,
        options,
      ),
    };
  }

  if (RUNNER_IN_FLIGHT_LIFECYCLE_STATES.has(lifecycleState)) {
    return {
      type: 'skipInvalidation',
      reason: 'command_still_in_flight',
      lifecycleState,
      lostReply: {
        recovery: 'command_still_in_flight',
        lifecycleState,
        message: `Runner command "${command.command}" is still ${lifecycleState} after the transport response was lost.`,
        hint: inFlightAfterLostResponseHint(
          command.command,
          lifecycleState,
          readReadinessPreflightRecoveryDetails(transportError),
        ),
      },
    };
  }

  return {
    type: 'retainInvalidation',
    reason: lifecycleState ? 'unknown_lifecycle_state' : 'missing_lifecycle_state',
    lifecycleState,
    lostReply: {
      recovery: 'lifecycle_state_not_recoverable',
      lifecycleState,
      cause: `lifecycle status was ${lifecycleState ? `"${lifecycleState}"` : 'missing'}`,
      hint: unknownLifecycleStateHint(command.command),
    },
  };
}

function handleCompletedRunnerStatus(
  status: Record<string, unknown>,
  command: RunnerCommand,
  transportError: AppError,
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
  return {
    type: 'skipInvalidation',
    reason: isReadOnlyRunnerCommand(command)
      ? 'read_only_completed_without_retained_response'
      : 'completed_without_retained_response',
    lifecycleState: 'completed',
    lostReply: {
      recovery: 'completed_without_retained_response',
      lifecycleState: 'completed',
      message: `Runner command "${command.command}" completed after the transport response was lost, but no recoverable response was retained.`,
      hint: completedWithoutRetainedResponseHint(
        command.command,
        readReadinessPreflightRecoveryDetails(transportError),
      ),
    },
  };
}

function runnerStatusFailureError(
  status: Record<string, unknown>,
  classification: RunnerReportedErrorClass,
  command: RunnerCommand,
  transportError: AppError,
  options: AppleRunnerCommandOptions,
): AppError {
  const errorMessage =
    typeof status.lifecycleErrorMessage === 'string'
      ? status.lifecycleErrorMessage
      : 'Runner command failed';
  const hint =
    typeof status.lifecycleErrorHint === 'string' ? status.lifecycleErrorHint : undefined;
  const readinessPreflight = readReadinessPreflightRecoveryDetails(transportError);
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

function lostReplyMessage(command: string, cause: string): string {
  return `Runner command "${command}" lost its transport response and ${cause}, so agent-device invalidated the runner session instead of replaying the command.`;
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
