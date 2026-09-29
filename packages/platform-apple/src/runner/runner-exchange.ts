import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { Deadline, emitDiagnostic, withDiagnosticTimer } from './host.ts';
import {
  waitForRunner,
  RUNNER_STARTUP_TIMEOUT_MS,
  type RunnerConnectionSession,
} from './runner-startup-transport.ts';
import { sendRunnerCommandOnce } from './runner-transport.ts';
import {
  buildRunnerResponseError,
  decodeRunnerResponseBody,
  isRunnerResponseOk,
  readRunnerResponseData,
  withRunnerCommandId,
  type RunnerCommand,
} from './runner-contract.ts';
import {
  resolveRunnerFatalErrorReason,
  isRunnerMainThreadOccupiedError,
  isStructuredRunnerFailure,
} from './runner-error-classification.ts';
import {
  canSkipRunnerReadinessPreflightAfterHealthyMutation,
  isReadOnlyRunnerCommand,
  isRunnerReadinessPreflightExempt,
  isRunnerReadinessProbeCommand,
} from './runner-command-traits.ts';
import {
  captureRunnerLogAttempt,
  enrichRunnerFailureFromLog,
  type RunnerLogAttempt,
} from './runner-failure-diagnostics.ts';
import { advanceRunnerSessionState, type RunnerSession } from './runner-session-types.ts';

type RunnerExchangeSession = RunnerConnectionSession &
  Pick<
    RunnerSession,
    'port' | 'commandCharges' | 'lastHealthyMutation' | 'runnerMainThreadBusy' | 'launchDeadline'
  >;

const RUNNER_READY_PREFLIGHT_TIMEOUT_MS = 1_000;
const RUNNER_PREFLIGHT_SKIP_FRESHNESS_MS = 5_000;

type RunnerReadinessPreflightDecision =
  | {
      action: 'run';
      reason:
        | 'startup'
        | 'conservative_command'
        | 'no_recent_healthy_mutation'
        | 'app_activation_uncertain'
        | 'healthy_mutation_stale';
      lastHealthyMutationAgeMs?: number;
    }
  | {
      action: 'skip';
      reason: 'read_only_startup_command' | 'readiness_probe_command' | 'preflight_exempt_command';
    }
  | {
      action: 'skip';
      reason: 'recent_healthy_mutation';
      lastHealthyMutationAgeMs: number;
    };

/**
 * Runs one command through a session. The command send charges the session and only this command's
 * own answer discharges it: an exchange this process abandoned to a cancellation or a dropped
 * transport keeps the runner occupied, which is what a graceful shutdown reads before handing it to
 * the next daemon (#2681). A command the runner answers inline is not charged at all, the same way
 * the readiness preflight's own probe is not: an inline reply is no evidence about the queued work a
 * charge stands for, so charging one would let it settle another command's debt (#2965).
 */
export async function executeRunnerExchange(
  device: DeviceInfo,
  session: RunnerExchangeSession,
  command: RunnerCommand,
  logPath: string | undefined,
  timeoutMs: number,
  invalidateFatalSession: (reason: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Drawn before anything is sent, including the preflight: whatever the runner writes from here on
  // is this command's attempt, and whatever is already in the log belongs to an earlier one (#2683).
  const logAttempt = await captureRunnerLogAttempt(logPath, { timeoutMs, signal });
  const runnerCommand = withRunnerCommandId(command);
  const readOnlyCommand = isReadOnlyRunnerCommand(runnerCommand);
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const preflightDecision = resolveRunnerReadinessPreflightDecision(session, runnerCommand);
  if (preflightDecision.action === 'run') {
    await runRunnerReadinessPreflight({
      device,
      session,
      runnerCommand,
      logAttempt,
      deadline,
      signal,
      decision: preflightDecision,
    });
  } else {
    emitRunnerReadinessPreflightSkipped(runnerCommand, session, preflightDecision);
  }

  let response: Response;
  try {
    response = await sendRunnerCommandAfterPreflight({
      device,
      session,
      runnerCommand,
      logPath,
      deadline,
      timeoutMs,
      signal,
      readOnlyCommand,
    });
  } catch (error) {
    // A transport failure right after a skipped preflight means the recency
    // bet was wrong; clear it so a flaky transport cannot loop on stale skips,
    // and mark the error with the skip context for status recovery. The marker
    // key is disjoint from runnerReadinessPreflightFailed, so this never routes
    // into the restart-and-replay path.
    throw markSkippedPreflightTransportError(error, session, preflightDecision);
  }
  try {
    const data = await parseRunnerResponse(response, session, logAttempt);
    await settleRunnerAnsweredExchange(session, runnerCommand, data, invalidateFatalSession);
    return data;
  } catch (error) {
    const answered = recordUnansweredRunnerExchange(session, runnerCommand, error);
    const runnerFatalReason = resolveRunnerFatalErrorReason(error);
    if (runnerFatalReason) {
      session.lastHealthyMutation = undefined;
      await invalidateFatalSession(runnerFatalReason);
      throw error;
    }
    // A body-read or malformed-payload failure is transport-shaped too (the
    // runner died mid-response); structured runner failures carry a `runner`
    // detail and keep their recency — the runner proved it is alive by
    // answering at all.
    if (answered) throw error;
    throw markSkippedPreflightTransportError(error, session, preflightDecision);
  }
}

/**
 * Records that this command's exchange got an answer: it discharges the charge, mirrors the
 * runner's occupancy report, and applies what the payload says about the session.
 */
async function settleRunnerAnsweredExchange(
  session: RunnerExchangeSession,
  runnerCommand: RunnerCommand,
  data: Record<string, unknown>,
  invalidateFatalSession: (reason: string) => Promise<void>,
): Promise<void> {
  session.commandCharges.settleAnswered(runnerCommand.commandId);
  // Mirror the runner's own main-thread occupancy stamped on this response: a runner that
  // served a read off the XCTest channel (e.g. a private-AX capture) while a tree crawl it
  // abandoned still grinds reports busy, so the healthy response must not be read as drained.
  // Only a present stamp carries information; a recovered or journal-replayed response is
  // written unstamped by design, and its absence must leave a prior busy report intact.
  const stampedMainThreadBusy = readRunnerMainThreadBusy(data);
  if (stampedMainThreadBusy !== undefined) {
    session.runnerMainThreadBusy = stampedMainThreadBusy;
  }
  const runnerFatalReason = resolveRunnerFatalReason(data);
  if (runnerFatalReason) {
    session.lastHealthyMutation = undefined;
    await invalidateFatalSession(runnerFatalReason);
  } else if (canSkipRunnerReadinessPreflightAfterHealthyMutation(runnerCommand)) {
    session.lastHealthyMutation = {
      atMs: Date.now(),
      appBundleId: runnerCommand.appBundleId,
    };
  }
}

/**
 * Records what a failed response proves about this command's exchange, and returns whether the
 * runner answered it.
 */
function recordUnansweredRunnerExchange(
  session: RunnerExchangeSession,
  runnerCommand: RunnerCommand,
  error: unknown,
): boolean {
  // A structured runner reply is an answer whatever it reports; a transport-shaped failure
  // (aborted body read, malformed payload) answered nothing and keeps the runner charged (#2681).
  const answered = isStructuredRunnerFailure(error);
  if (answered) {
    session.commandCharges.settleAnswered(runnerCommand.commandId);
  } else {
    session.commandCharges.markAbandoned(runnerCommand.commandId);
  }
  // A main-thread occupancy report (`RUNNER_BUSY`, or the `MAIN_THREAD_TIMEOUT` the stalling
  // command itself returns) marks the runner still draining. Any OTHER structured runner reply was
  // served off that abandoned work, so it has drained; a transport-shaped error answered nothing
  // and leaves the report intact (#2552).
  if (isRunnerMainThreadOccupiedError(error)) {
    session.runnerMainThreadBusy = true;
  } else if (answered) {
    session.runnerMainThreadBusy = false;
  }
  return answered;
}

function readRunnerMainThreadBusy(data: Record<string, unknown>): boolean | undefined {
  return typeof data.runnerMainThreadBusy === 'boolean' ? data.runnerMainThreadBusy : undefined;
}

function markSkippedPreflightTransportError(
  error: unknown,
  session: RunnerExchangeSession,
  preflightDecision: RunnerReadinessPreflightDecision,
): unknown {
  if (
    preflightDecision.action !== 'skip' ||
    preflightDecision.reason !== 'recent_healthy_mutation'
  ) {
    return error;
  }
  session.lastHealthyMutation = undefined;
  return markRunnerPreflightError(error, {
    runnerReadinessPreflightSkipped: true,
    runnerReadinessPreflightSkipReason: preflightDecision.reason,
    runnerReadinessPreflightSkippedAgeMs: preflightDecision.lastHealthyMutationAgeMs,
  });
}

async function sendRunnerCommandAfterPreflight(params: {
  device: DeviceInfo;
  session: RunnerExchangeSession;
  runnerCommand: RunnerCommand;
  logPath: string | undefined;
  deadline: Deadline;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  readOnlyCommand: boolean;
}): Promise<Response> {
  const { device, session, runnerCommand, logPath, deadline, timeoutMs, signal, readOnlyCommand } =
    params;
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) {
    throw new AppError('COMMAND_FAILED', 'Runner command deadline exceeded', { timeoutMs });
  }
  const diagnosticData = readOnlyCommand
    ? {
        command: runnerCommand.command,
        commandId: runnerCommand.commandId,
        readOnly: true,
        sessionReady: session.state === 'ready',
        timeoutMs: remainingMs,
      }
    : { command: runnerCommand.command, commandId: runnerCommand.commandId };

  // From here the runner holds our request, and a shutdown that hands it off would orphan a command
  // nobody is waiting for any more. A readiness probe is charged no more than the preflight's own
  // probe is: the runner serves it inline, so its reply says nothing about the queued work a charge
  // stands for, and charging it would let one probe settle another command's debt (#2965). The trait
  // that names the probe is pinned to the runner's inline routing by `runner-readiness-routing.test.ts`.
  const charged = !isRunnerReadinessProbeCommand(runnerCommand);
  if (charged) session.commandCharges.charge(runnerCommand.commandId);
  try {
    return await withDiagnosticTimer(
      'ios_runner_command_send',
      async () => {
        if (readOnlyCommand) {
          return await waitForRunner(
            device,
            session.port,
            runnerCommand,
            logPath,
            remainingMs,
            session,
            signal,
          );
        }
        return await sendRunnerCommandOnce(
          device,
          session.port,
          runnerCommand,
          remainingMs,
          signal,
        );
      },
      diagnosticData,
    );
  } catch (error) {
    if (charged) session.commandCharges.markAbandoned(runnerCommand.commandId);
    throw error;
  }
}

async function runRunnerReadinessPreflight(params: {
  device: DeviceInfo;
  session: RunnerExchangeSession;
  runnerCommand: RunnerCommand;
  logAttempt: RunnerLogAttempt | undefined;
  deadline: Deadline;
  signal: AbortSignal | undefined;
  decision: Extract<RunnerReadinessPreflightDecision, { action: 'run' }>;
}): Promise<void> {
  const { device, session, runnerCommand, logAttempt, deadline, signal, decision } = params;
  const logPath = logAttempt?.logPath;
  const readinessTimeoutMs =
    session.state === 'ready'
      ? Math.min(RUNNER_READY_PREFLIGHT_TIMEOUT_MS, deadline.remainingMs())
      : Math.min(readRunnerStartupTimeoutMs(session), deadline.remainingMs());
  try {
    const readinessResponse = await withDiagnosticTimer(
      'ios_runner_readiness_preflight',
      async () =>
        await waitForRunner(
          device,
          session.port,
          withRunnerCommandId({ command: 'uptime' }),
          logPath,
          readinessTimeoutMs,
          session,
          signal,
        ),
      {
        command: runnerCommand.command,
        commandId: runnerCommand.commandId,
        reason: decision.reason,
        lastHealthyMutationAgeMs: decision.lastHealthyMutationAgeMs,
        sessionReady: session.state === 'ready',
        timeoutMs: readinessTimeoutMs,
      },
    );
    const readinessData = await parseRunnerResponse(readinessResponse, session, logAttempt);
    const stampedMainThreadBusy = readRunnerMainThreadBusy(readinessData);
    if (stampedMainThreadBusy !== undefined) {
      session.runnerMainThreadBusy = stampedMainThreadBusy;
    }
  } catch (error) {
    throw markRunnerReadinessPreflightError(error);
  }
}

function emitRunnerReadinessPreflightSkipped(
  runnerCommand: RunnerCommand,
  session: RunnerExchangeSession,
  decision: Extract<RunnerReadinessPreflightDecision, { action: 'skip' }>,
): void {
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_readiness_preflight_skipped',
    data: {
      command: runnerCommand.command,
      commandId: runnerCommand.commandId,
      reason: decision.reason,
      lastHealthyMutationAgeMs:
        decision.reason === 'recent_healthy_mutation'
          ? decision.lastHealthyMutationAgeMs
          : undefined,
      sessionReady: session.state === 'ready',
    },
  });
}

/**
 * Reads one runner response body and records what it proved about the session (#2662). Only a
 * session waiting for its first answer changes: the runner replied, so it is `ready`. A session
 * already going away keeps its state — an answer arriving after disposal started comes from a
 * runner on its way out, not from a session that can take work.
 */
export async function parseRunnerResponse(
  response: Response,
  session: Pick<RunnerSession, 'state'>,
  /** The command's own log boundary. Absent means no log was configured, so nothing is read. */
  logAttempt?: RunnerLogAttempt,
): Promise<Record<string, unknown>> {
  const payload = decodeRunnerResponseBody(await response.text());
  if (!isRunnerResponseOk(payload)) {
    throw await enrichRunnerFailureFromLog({
      error: buildRunnerResponseError(payload, logAttempt?.logPath),
      logSince: logAttempt,
    });
  }
  advanceRunnerSessionState(session, 'ready');
  const data = readRunnerResponseData(payload);
  emitRunnerResponseDiagnostics(data);
  return data;
}

function emitRunnerResponseDiagnostics(data: Record<string, unknown>): void {
  const fallback = data.gestureFallback;
  if (typeof fallback !== 'string' || fallback.length === 0) return;
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_gesture_fallback',
    data: {
      fallback,
      message:
        typeof data.gestureFallbackMessage === 'string' ? data.gestureFallbackMessage : undefined,
      hint: typeof data.gestureFallbackHint === 'string' ? data.gestureFallbackHint : undefined,
    },
  });
}

function resolveRunnerFatalReason(data: Record<string, unknown>): string | undefined {
  if (data.runnerFatal !== true) return undefined;
  return typeof data.runnerFatalReason === 'string' && data.runnerFatalReason.trim().length > 0
    ? data.runnerFatalReason
    : 'runner_reported_fatal_response';
}

function resolveRunnerReadinessPreflightDecision(
  session: RunnerExchangeSession,
  command: RunnerCommand,
): RunnerReadinessPreflightDecision {
  const readOnlyCommand = isReadOnlyRunnerCommand(command);
  if (isRunnerReadinessPreflightExempt(command)) {
    return { action: 'skip', reason: 'preflight_exempt_command' };
  }
  if (session.state !== 'ready') {
    if (readOnlyCommand) {
      return {
        action: 'skip',
        reason: 'read_only_startup_command',
      };
    }
    return {
      action: 'run',
      reason: 'startup',
    };
  }
  if (isRunnerReadinessProbeCommand(command)) {
    return {
      action: 'skip',
      reason: 'readiness_probe_command',
    };
  }
  if (!canSkipRunnerReadinessPreflightAfterHealthyMutation(command)) {
    // CONSERVATIVE: Commands outside the healthy-mutation allowlist still preflight because their
    // terminal runner state is not proven by recency. Revisit when lifecycle status coverage can
    // distinguish every mutating command's safe terminal state.
    return {
      action: 'run',
      reason: 'conservative_command',
    };
  }
  const record = session.lastHealthyMutation;
  if (!record) {
    return {
      action: 'run',
      reason: 'no_recent_healthy_mutation',
    };
  }
  if (command.appBundleId !== record.appBundleId) {
    return {
      action: 'run',
      reason: 'app_activation_uncertain',
    };
  }
  const lastHealthyMutationAgeMs = Date.now() - record.atMs;
  if (lastHealthyMutationAgeMs > RUNNER_PREFLIGHT_SKIP_FRESHNESS_MS) {
    return {
      action: 'run',
      reason: 'healthy_mutation_stale',
      lastHealthyMutationAgeMs,
    };
  }
  return {
    action: 'skip',
    reason: 'recent_healthy_mutation',
    lastHealthyMutationAgeMs,
  };
}

function markRunnerReadinessPreflightError(error: unknown): AppError {
  return markRunnerPreflightError(error, {
    runnerReadinessPreflightFailed: true,
  });
}

function markRunnerPreflightError(error: unknown, details: Record<string, unknown>): AppError {
  const appErr =
    error instanceof AppError
      ? error
      : new AppError(
          'COMMAND_FAILED',
          error instanceof Error ? error.message : String(error),
          undefined,
          error,
        );
  return new AppError(
    appErr.code,
    appErr.message,
    {
      ...(appErr.details ?? {}),
      ...details,
    },
    appErr.cause ?? error,
  );
}

/**
 * What a request waiting on a `starting` session may spend on its readiness: the rest of the
 * session's launch budget, never a fresh one per joiner. A session with no recorded launch (a
 * fixture, or one registered before the deadline existed) falls back to the default budget.
 */
export function readRunnerStartupTimeoutMs(session: Pick<RunnerSession, 'launchDeadline'>): number {
  const launchDeadline = session.launchDeadline;
  if (!launchDeadline) return RUNNER_STARTUP_TIMEOUT_MS;
  return Math.max(0, Math.floor(launchDeadline.remainingMs()));
}
