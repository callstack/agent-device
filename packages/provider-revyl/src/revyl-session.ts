import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { buildRevylDevice, REVYL_SNAPSHOT_CHANNEL, type RevylPlatform } from './device.ts';
import {
  isRevylSessionGone,
  revylFailureRefusedTheRequest,
  REVYL_START_DEVICE_TIMEOUT_MS,
  type RevylClient,
} from './revyl-client.ts';
import { revylSessionIdForLease } from './session-identity.ts';
import type {
  RevylStartDeviceRequest,
  RevylStartDeviceResponse,
  RevylWorkerHealth,
} from './revyl-types.ts';

/** How long Revyl may take to assign a worker and connect the device before the start is given up on. */
const READY_TIMEOUT_MS = 240_000;
/** Revyl's worker answers `health` with 503 until the device is attached; the CLI polls on that beat. */
const READY_POLL_INTERVAL_MS = 2_000;
/** Revyl releases an idle session on its own; this is the lease the runtime asks for. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30 * 60;
/** Revyl answers a device-proxy action the worker cannot serve yet with these. */
const NOT_READY_STATUSES = new Set([503, 409]);

export type RevylScreenSize = Readonly<{ width: number; height: number }>;

/** One live Revyl session: the run its actions route to, and the session that ends it. */
export type RevylSession = Readonly<{
  platform: RevylPlatform;
  /** The device-proxy routing key every action path is built from. */
  runId: string;
  /** What Revyl's `/stop` endpoint takes; the runtime issues it, so it is always known. */
  sessionId: string;
  /** Read from `health`; a snapshot without it cannot measure a keyboard band. */
  screen: RevylScreenSize | undefined;
  device: DeviceInfo;
  /** The channel a `hierarchy` answer is parsed and presented on for this platform. */
  snapshotChannel: (typeof REVYL_SNAPSHOT_CHANNEL)[RevylPlatform];
  client: RevylClient;
  lease: DeviceLease;
  /**
   * The app this session last launched, which is the only one Revyl's `/kill_app` can end: that action
   * carries no bundle id. Held in a box so the session itself stays a frozen value.
   */
  launchedApp: { bundleId?: string };
}>;

export type RevylStartRequestInput = Readonly<{
  platform: RevylPlatform;
  appUrl: string | undefined;
  deviceModel: string | undefined;
  osVersion: string | undefined;
  signal?: AbortSignal;
  /** Epoch-ms deadline the caller has for the whole allocation; it outranks the runtime's own. */
  deadline?: number;
}>;

/**
 * One caller's own patience: the signal it cancels with and the deadline it stops at. Both are optional,
 * and a caller with neither waits for whatever its work takes.
 */
export type RevylCallerBudget = Readonly<{ signal?: AbortSignal; deadline?: number }>;

/**
 * One caller's wait for work this process is already doing, bounded by that caller's own deadline and
 * canceled with its own signal. `settled` says whether this wait is what ended the race, which is what
 * lets a caller report its own cancellation rather than the outcome of a shared request it stopped
 * watching. `dispose` retires the listener once the work itself is done.
 */
export type RevylCallerWait<T> = Readonly<{
  promise: Promise<T>;
  settled: () => boolean;
  dispose: () => void;
}>;

/**
 * What one start has to undo: the session that holds the rented device, and the run that routes to
 * it. `sessionId` is always the id the backend was told, or the one it answered with, so the end
 * always addresses what Revyl actually holds.
 */
type RevylStartCleanup = Readonly<{ runId?: string; sessionId: string }>;

/**
 * Starts a Revyl device and waits until it answers: `start_device`, then the worker-connection poll,
 * then `health` until the device reports connected. A start that never became ready is stopped before
 * the failure reaches the caller, so a failed allocate never leaves a rented device running — and a
 * stop that failed is named in the failure, because the device is still rented.
 */
export async function startRevylSession(
  client: RevylClient,
  lease: DeviceLease,
  input: RevylStartRequestInput,
): Promise<RevylSession> {
  // The runtime issues the session id rather than reading it back, so a session this lease started
  // can be ended from the lease alone — including from a process that never started it.
  const sessionId = revylSessionIdForLease(lease.leaseId);
  const request: RevylStartDeviceRequest = {
    platform: input.platform,
    is_simulation: true,
    session_id: sessionId,
    idle_timeout_seconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
    ...(input.appUrl === undefined ? {} : { app_url: input.appUrl }),
    ...(input.deviceModel === undefined ? {} : { device_model: input.deviceModel }),
    ...(input.osVersion === undefined ? {} : { os_version: input.osVersion }),
  };
  const started = await submitRevylStart(client, request, sessionId, input);
  const runId = typeof started.workflow_run_id === 'string' ? started.workflow_run_id : undefined;
  const echoed = typeof started.session_id === 'string' ? started.session_id : undefined;
  if (runId && echoed && echoed !== sessionId) {
    // Every later stop addresses the session by the id the runtime issued, and an expired-lease
    // recovery in another process derives that same id from the lease. A backend that kept its own
    // identity therefore has to be refused, and the id it named is the only handle that still names
    // the device: that is what gets stopped and what the failure reports.
    const cleanup: RevylStartCleanup = { runId, sessionId: echoed };
    throwIfStartStopFailed(
      cleanup,
      await stopStartedSession(client, cleanup),
      new AppError(
        'COMMAND_FAILED',
        `Revyl started the device as session ${echoed} instead of ${sessionId}.`,
        {
          reason: 'provider-session-identity-mismatch',
          runId,
          providerSessionId: echoed,
          hint: 'Retry the command; agent-device ends a Revyl session by the identity it issued.',
        },
      ),
    );
  }
  if (!runId) {
    // Revyl opened a session and only failed to hand back a run. The id it echoes names that session
    // when it kept its own, so cleanup addresses the session the backend actually holds.
    const cleanup: RevylStartCleanup = { sessionId: echoed ?? sessionId };
    throwIfStartStopFailed(
      cleanup,
      await stopStartedSession(client, cleanup),
      new AppError(
        'COMMAND_FAILED',
        `Revyl did not start a ${input.platform} device: ${started.error ?? started.message ?? 'no workflow run was returned'}`,
        {
          reason: 'provider-start-refused',
          platform: input.platform,
          ...(started.trace_id === undefined ? {} : { traceId: started.trace_id }),
        },
      ),
    );
  }
  // Revyl may have answered a run for a start the caller already gave up on. That device is rented
  // either way, so it is stopped here before the cancellation reaches the caller.
  if (input.signal?.aborted) {
    const cleanup: RevylStartCleanup = { runId, sessionId };
    throwIfStartStopFailed(
      cleanup,
      await stopStartedSession(client, cleanup),
      startCanceled(input),
    );
  }
  const deadline = readinessDeadline(input);
  try {
    const health = await awaitRevylDeviceReady(client, runId, deadline, input);
    return {
      platform: input.platform,
      runId,
      sessionId,
      screen: readRevylScreenSize(health),
      device: buildRevylDevice(input.platform, lease, runId),
      snapshotChannel: REVYL_SNAPSHOT_CHANNEL[input.platform],
      client,
      lease,
      launchedApp: {},
    };
  } catch (error) {
    const cleanup: RevylStartCleanup = { runId, sessionId };
    throwIfStartStopFailed(cleanup, await stopStartedSession(client, cleanup), error);
  }
}

/**
 * Sends `start_device` within the caller's budget. The request rents a device even when the caller
 * hangs up, so two things keep that from leaking: the wait is bounded by the shorter of the caller's
 * whole-allocation deadline and the client's own start timeout, and the session id is issued before
 * the request goes out, so an answer nobody read still leaves a session that can be stopped by that
 * id. The caller's cancellation never travels on the request itself: aborting the fetch discards the
 * answer, and an answer nobody read is a rented device with no run id.
 */
async function submitRevylStart(
  client: RevylClient,
  request: RevylStartDeviceRequest,
  sessionId: string,
  input: RevylStartRequestInput,
): Promise<RevylStartDeviceResponse> {
  if (input.signal?.aborted) throw startCanceled(input);
  const callerDeadline = input.deadline ?? Number.POSITIVE_INFINITY;
  const requestDeadline = startDeadline(input);
  // Only the request's own budget travels on it. The caller's wait is bounded beside it.
  const start = client.startDevice(
    request,
    AbortSignal.timeout(Math.max(0, requestDeadline - Date.now())),
  );
  const gaveUp = callerWait(callerDeadline, input);
  try {
    return await (gaveUp === undefined ? start : Promise.race([start, gaveUp.promise]));
  } catch (error) {
    // The caller may have stopped waiting, or the request may have gone out without an answer. Either
    // way something may be rented under the id this request carried, so it is stopped by that id
    // before the failure returns: the caller's failure stays the reported one, and a stop that failed
    // says what is still billed.
    if (gaveUp?.settled() === true || startMayHaveRented(error)) {
      const cleanup: RevylStartCleanup = { sessionId };
      throwIfStartStopFailed(
        cleanup,
        await stopStartedSession(client, cleanup),
        gaveUp?.settled() === true ? startCanceled(input) : error,
      );
    }
    throw error;
  } finally {
    gaveUp?.dispose();
  }
}

/**
 * One caller's wait for work this process is already doing, bounded by that caller's own deadline and
 * canceled with its own signal. `settled` says whether this wait is what ended the race, which is what
 * lets a caller report its own cancellation rather than the outcome of a shared request it stopped
 * watching. `dispose` retires the listener once the work itself is done.
 */
export function revylCallerWait<T>(
  deadline: number,
  budget: RevylCallerBudget,
  onGiveUp: () => unknown,
): RevylCallerWait<T> | undefined {
  if (budget.deadline === undefined && budget.signal === undefined) return undefined;
  const parts: AbortSignal[] = [];
  if (Number.isFinite(deadline))
    parts.push(AbortSignal.timeout(Math.max(0, deadline - Date.now())));
  if (budget.signal !== undefined) parts.push(budget.signal);
  const signal = parts.length === 1 ? parts[0]! : AbortSignal.any(parts);
  let rejected = false;
  let onAbort: () => void = () => {};
  const reject = (reason: unknown) => {
    rejected = true;
    return reason;
  };
  // A signal that is already aborted never fires its listener, so that wait has to start over the
  // edge rather than sit on it.
  const promise = signal.aborted
    ? Promise.reject(reject(onGiveUp()))
    : new Promise<T>((_, rejectPromise) => {
        onAbort = () => rejectPromise(reject(onGiveUp()));
        signal.addEventListener('abort', onAbort, { once: true });
      });
  return Object.freeze({
    promise,
    settled: () => rejected,
    dispose: () => signal.removeEventListener('abort', onAbort),
  });
}

/**
 * The caller's own wait for the start, or absent when the caller gave it neither a deadline nor a
 * signal and the request's timeout is all there is to wait for.
 */
function callerWait(
  deadline: number,
  input: RevylStartRequestInput,
): RevylCallerWait<RevylStartDeviceResponse> | undefined {
  return revylCallerWait<RevylStartDeviceResponse>(deadline, input, () => startCanceled(input));
}

/** The start phase's budget: the caller's whole-allocation deadline when it is shorter than the client's. */
function startDeadline(input: RevylStartRequestInput): number {
  const own = Date.now() + REVYL_START_DEVICE_TIMEOUT_MS;
  return input.deadline === undefined ? own : Math.min(own, input.deadline);
}

function startCanceled(input: RevylStartRequestInput): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'The Revyl device start was canceled before it was ready.',
    { reason: 'request_canceled', platform: input.platform },
    input.signal?.reason,
  );
}

/**
 * The failure for a caller that stopped waiting for a device: its own cancellation when it hung up, and
 * the budget that ran out when it did not. `budgetMs` is the wait that ended, which is the number the
 * report has to name — the readiness phase's own budget there, the caller's whole deadline for a join
 * that never had a phase of its own.
 */
export function revylCallerGaveUp(
  platform: RevylPlatform,
  budget: RevylCallerBudget,
  budgetMs: number,
): AppError {
  if (budget.signal?.aborted) {
    return new AppError(
      'COMMAND_FAILED',
      'The Revyl device start was canceled before it was ready.',
      { reason: 'request_canceled', platform },
      budget.signal.reason,
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `Revyl did not report a ready device within ${budgetMs} ms.`,
    {
      reason: 'provider-not-ready',
      timeoutMs: budgetMs,
      ...(budget.deadline === undefined ? {} : { deadline: budget.deadline }),
      hint: 'Retry the command; Revyl may have had no device of that model available.',
    },
  );
}

/**
 * Whether a `start_device` that never reached the caller may still have rented a device. Only a status
 * the backend settled with a refusal rules that out, and that is one read of the client's status table.
 * A lost answer, an unreachable backend, an unconfirmed status, or the caller hanging up all leave the
 * session possibly open under the id the request carried, which is the id this module issued.
 */
function startMayHaveRented(error: unknown): boolean {
  return !revylFailureRefusedTheRequest(error);
}

/**
 * Ends what one start rented, and reports the failure instead of swallowing it: a caller that cannot
 * reach Revyl has to hear that the device it asked for is still rented. A session Revyl no longer has
 * is the success this path wants, so it is not a failure.
 */
async function stopStartedSession(
  client: RevylClient,
  cleanup: RevylStartCleanup,
): Promise<unknown | undefined> {
  try {
    await stopRevylSession(client, cleanup.runId, cleanup.sessionId);
    return undefined;
  } catch (error) {
    return isRevylSessionGone(error) ? undefined : error;
  }
}

/**
 * Reports a rented device the start could not hand back. The caller's own failure becomes the cause:
 * what is still billed outranks why the start did not finish, and the session id in the details is
 * what has to be ended by hand.
 */
function throwIfStartStopFailed(
  cleanup: RevylStartCleanup,
  stopFailure: unknown | undefined,
  startFailure: unknown,
): never {
  if (stopFailure === undefined) throw startFailure;
  throw new AppError(
    'COMMAND_FAILED',
    `Revyl did not release the session it started (${cleanup.sessionId}).`,
    {
      reason: 'provider-cleanup-pending',
      providerSessionId: cleanup.sessionId,
      ...(cleanup.runId === undefined ? {} : { runId: cleanup.runId }),
      cause: errorMessage(stopFailure),
      hint: `End the Revyl session ${cleanup.sessionId}; the device stays rented and billed until it is.`,
    },
    startFailure,
  );
}

/** The readiness budget: the instant it runs out, and how much of it the caller was given. */
type RevylDeadline = Readonly<{ at: number; budgetMs: number }>;

/** The caller's own budget wins when it is shorter, so a start never outlives the lease request. */
function readinessDeadline(input: RevylStartRequestInput): RevylDeadline {
  const remaining =
    input.deadline === undefined
      ? READY_TIMEOUT_MS
      : Math.min(READY_TIMEOUT_MS, input.deadline - Date.now());
  return { at: Date.now() + remaining, budgetMs: Math.max(0, remaining) };
}

async function awaitRevylDeviceReady(
  client: RevylClient,
  runId: string,
  deadline: RevylDeadline,
  input: RevylStartRequestInput,
): Promise<RevylWorkerHealth> {
  await untilRevylWorkerReady(client, runId, deadline, input);
  for (;;) {
    requireTime(deadline, input);
    const response = await readWorkerHealth(client, runId, deadline, input);
    // The deadline is checked again on the answer's heels: a late success still missed it.
    requireTime(deadline, input);
    if (response.device_connected === true) return response;
    await sleepBefore(deadline, input.signal);
  }
}

/**
 * One `health` read. Revyl answers it with 503, and the worker with 409, while the device is not
 * attached yet, which is the same not-ready a `device_connected: false` answer carries.
 */
async function readWorkerHealth(
  client: RevylClient,
  runId: string,
  deadline: RevylDeadline,
  input: RevylStartRequestInput,
): Promise<RevylWorkerHealth> {
  try {
    return await runWithinDeadline(
      () => client.getWorkerHealth(runId, pollSignal(deadline, input)),
      deadline,
      input,
    );
  } catch (error) {
    if (!isProviderNotReady(error)) throw error;
    return {};
  }
}

/**
 * Runs one readiness poll and reports a failure the deadline explains as the deadline's own answer.
 * A poll the budget cut short reaches the client as a cancellation, and a caller that never canceled
 * has to hear that Revyl was too slow rather than that the request was canceled.
 */
async function runWithinDeadline<T>(
  poll: () => Promise<T>,
  deadline: RevylDeadline,
  input: RevylStartRequestInput,
): Promise<T> {
  try {
    return await poll();
  } catch (error) {
    requireTime(deadline, input);
    throw error;
  }
}

/** Revyl has not served this action yet, so the reason is transient and the poll continues. */
function isProviderNotReady(error: unknown): boolean {
  return (
    error instanceof AppError &&
    typeof error.details?.providerStatus === 'number' &&
    NOT_READY_STATUSES.has(error.details.providerStatus)
  );
}

/** The worker-connection poll. `cancelled`, `stopped` and `failed` are terminal: no later poll is ready. */
async function untilRevylWorkerReady(
  client: RevylClient,
  runId: string,
  deadline: RevylDeadline,
  input: RevylStartRequestInput,
): Promise<void> {
  for (;;) {
    requireTime(deadline, input);
    const connection = await runWithinDeadline(
      () => client.getWorkerConnection(runId, pollSignal(deadline, input)),
      deadline,
      input,
    );
    requireTime(deadline, input);
    if (connection.status === 'ready' && connection.worker_ws_url) return;
    if (
      connection.status === 'cancelled' ||
      connection.status === 'stopped' ||
      connection.status === 'failed'
    ) {
      throw new AppError(
        'COMMAND_FAILED',
        `Revyl did not start the ${input.platform} device: ${connection.status}${
          connection.message === null || connection.message === undefined
            ? ''
            : ` (${connection.message})`
        }`,
        { reason: 'provider-start-failed', runId, status: connection.status },
      );
    }
    await sleepBefore(deadline, input.signal);
  }
}

/** Fails the moment the readiness budget is spent, whatever a poll that was already sent answers. */
function requireTime(deadline: RevylDeadline, input: RevylStartRequestInput): void {
  if (Date.now() < deadline.at) return;
  // The budget is the caller's deadline when it is shorter, so the number named has to be the one that
  // actually ran out.
  throw revylCallerGaveUp(input.platform, input, deadline.budgetMs);
}

/** The remaining readiness budget, so a poll that outlives it is canceled rather than awaited. */
function pollSignal(deadline: RevylDeadline, input: RevylStartRequestInput): AbortSignal {
  const remaining = AbortSignal.timeout(Math.max(0, deadline.at - Date.now()));
  return input.signal === undefined ? remaining : AbortSignal.any([input.signal, remaining]);
}

async function sleepBefore(deadline: RevylDeadline, signal?: AbortSignal): Promise<void> {
  await sleep(
    Math.min(READY_POLL_INTERVAL_MS, Math.max(0, deadline.at - Date.now())),
    undefined,
    signal === undefined ? {} : { signal },
  ).catch(() => undefined);
}

/**
 * Ends one Revyl session. `/stop` is idempotent, so a repeat release is safe, and a session with no
 * run to route to is ended by its session id — the same pair of ends Revyl's own clients take.
 */
export async function stopRevylSession(
  client: RevylClient,
  runId: string | undefined,
  sessionId: string | undefined,
): Promise<void> {
  if (sessionId) {
    await client.stopDeviceSession(sessionId);
    return;
  }
  if (runId) await client.cancelDeviceRun(runId);
}

function readRevylScreenSize(health: RevylWorkerHealth): RevylScreenSize | undefined {
  const { screen_width: width, screen_height: height } = health;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { width, height };
}
