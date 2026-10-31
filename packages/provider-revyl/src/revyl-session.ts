import { AppError } from '@agent-device/kernel/errors';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { buildRevylDevice, type RevylPlatform } from './device.ts';
import { revylFailureRefusedTheRequest, type RevylClient } from './revyl-client.ts';
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
 * The session one start left under rent: the session that holds the device, and the run that routes to
 * it. `sessionId` is always the id the backend was told, or the one it answered with, so the end always
 * addresses what Revyl actually holds.
 */
export type RevylRentedSession = Readonly<{ runId?: string; sessionId: string }>;

/**
 * What one start amounted to. A start either hands over a ready device, or fails and says whether it left
 * a session behind: `rented` is what has to be stopped, absent when Revyl settled with a refusal that
 * started nothing.
 *
 * This is the whole shape of the cleanup contract: the start names what it rented and never ends it, so
 * the one place that holds the lease holds the only handle for ending it.
 */
export type RevylStart =
  | Readonly<{ status: 'ready'; session: RevylSession }>
  | Readonly<{ status: 'failed'; error: unknown; rented?: RevylRentedSession }>;

/**
 * Starts a Revyl device and waits until it answers: `start_device`, then the worker-connection poll,
 * then `health` until the device reports connected. Whatever the outcome, the answer says what Revyl is
 * holding, so the caller can end it — including when the answer lands after the caller stopped waiting,
 * which is the case a discarded request would get wrong.
 */
export async function startRevylSession(
  client: RevylClient,
  lease: DeviceLease,
  input: RevylStartRequestInput,
): Promise<RevylStart> {
  // The runtime issues the session id rather than reading it back, so a session this lease started
  // can be ended from the lease alone — including from a process that never started it.
  const sessionId = revylSessionIdForLease(lease.leaseId);
  // Nothing has been sent yet, so nothing is rented: this caller is answered with its own cancellation and
  // the entry closes without asking Revyl for a session it never made.
  if (input.signal?.aborted) return { status: 'failed', error: startCanceled(input) };
  let started: RevylStartDeviceResponse;
  try {
    started = await submitRevylStart(client, input, sessionId);
  } catch (error) {
    // The request went out and never came back with a refusal, so a session may be open under the id it
    // carried. That id is the handle the caller has to end.
    return {
      status: 'failed',
      error,
      ...(startMayHaveRented(error) ? { rented: { sessionId } } : {}),
    };
  }
  const runId = typeof started.workflow_run_id === 'string' ? started.workflow_run_id : undefined;
  const echoed = typeof started.session_id === 'string' ? started.session_id : undefined;
  if (runId && echoed && echoed !== sessionId) {
    // Every later stop addresses the session by the id the runtime issued, and an expired-lease
    // recovery in another process derives that same id from the lease. A backend that kept its own
    // identity therefore has to be refused, and the id it named is the only handle that still names
    // the device: that is what `rented` reports, and what the failure names.
    return {
      status: 'failed',
      rented: { runId, sessionId: echoed },
      error: new AppError(
        'COMMAND_FAILED',
        `Revyl started the device as session ${echoed} instead of ${sessionId}.`,
        {
          reason: 'provider-session-identity-mismatch',
          runId,
          providerSessionId: echoed,
          hint: 'Retry the command; agent-device ends a Revyl session by the identity it issued.',
        },
      ),
    };
  }
  if (!runId) {
    // Revyl opened a session and only failed to hand back a run. The id it echoes names that session
    // when it kept its own, so the end addresses the session the backend actually holds.
    return {
      status: 'failed',
      rented: { sessionId: echoed ?? sessionId },
      error: new AppError(
        'COMMAND_FAILED',
        `Revyl did not start a ${input.platform} device: ${started.error ?? started.message ?? 'no workflow run was returned'}`,
        {
          reason: 'provider-start-refused',
          platform: input.platform,
          ...(started.trace_id === undefined ? {} : { traceId: started.trace_id }),
        },
      ),
    };
  }
  // Revyl may have answered a run for a start whose caller has already hung up. The device is rented
  // either way, so the answer still reports it as what is owed an end.
  if (input.signal?.aborted) {
    return {
      status: 'failed',
      rented: { runId, sessionId },
      error: startCanceled(input),
    };
  }
  const deadline = readinessDeadline(input);
  try {
    const health = await awaitRevylDeviceReady(client, runId, deadline, { ...input, sessionId });
    return {
      status: 'ready',
      session: {
        platform: input.platform,
        runId,
        sessionId,
        screen: readRevylScreenSize(health),
        device: buildRevylDevice(input.platform, lease, runId),
        client,
        lease,
        launchedApp: {},
      },
    };
  } catch (error) {
    return { status: 'failed', error, rented: { runId, sessionId } };
  }
}

/**
 * Sends `start_device` and returns its answer. The caller's cancellation never travels on the request:
 * aborting the fetch discards the answer, and an answer nobody read is a rented device with no run id. The
 * session id is issued before the request goes out for the same reason — an answer nobody read still leaves
 * a session that can be stopped by that id — and the request keeps the client's own start budget rather
 * than the caller's shorter one, so an answer still comes back to name what was rented.
 */
async function submitRevylStart(
  client: RevylClient,
  input: RevylStartRequestInput,
  sessionId: string,
): Promise<RevylStartDeviceResponse> {
  if (input.signal?.aborted) throw startCanceled(input);
  const request: RevylStartDeviceRequest = {
    platform: input.platform,
    is_simulation: true,
    session_id: sessionId,
    idle_timeout_seconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
    ...(input.appUrl === undefined ? {} : { app_url: input.appUrl }),
    ...(input.deviceModel === undefined ? {} : { device_model: input.deviceModel }),
    ...(input.osVersion === undefined ? {} : { os_version: input.osVersion }),
  };
  return await client.startDevice(request);
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
  providerSessionId: string,
): AppError {
  // The start keeps running after this caller leaves, and the runtime stops whatever it rents. The
  // session id is still named, because a stop that fails then has no caller left to report to.
  const pending = `agent-device stops Revyl session ${providerSessionId} once its start answers; end it from Revyl if it stays listed.`;
  if (budget.signal?.aborted) {
    return new AppError(
      'COMMAND_FAILED',
      'The Revyl device start was canceled before it was ready.',
      { reason: 'request_canceled', platform, providerSessionId, hint: pending },
      budget.signal.reason,
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `Revyl did not report a ready device within ${budgetMs} ms.`,
    {
      reason: 'provider-not-ready',
      timeoutMs: budgetMs,
      providerSessionId,
      ...(budget.deadline === undefined ? {} : { deadline: budget.deadline }),
      hint: `Retry the command; Revyl may have had no device of that model available. ${pending}`,
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

/** A rented session whose `/stop` Revyl did not confirm, and why. */
export type RevylUnconfirmedStop = RevylRentedSession & Readonly<{ failure: string }>;

/**
 * The one report for Revyl sessions that are still rented because their stop was not confirmed. The ids
 * are in the message and the hint as well as the details, because a host that forwards only a failure's
 * message and hint must still tell an operator which billed devices to end.
 */
export function revylCleanupPending(
  unconfirmed: readonly RevylUnconfirmedStop[],
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): AppError {
  const ids = unconfirmed.map((stop) => stop.sessionId).join(', ');
  const one = unconfirmed.length === 1 ? unconfirmed[0] : undefined;
  return new AppError(
    'COMMAND_FAILED',
    `Revyl did not release session${one ? '' : 's'} ${ids}.`,
    {
      reason: 'provider-cleanup-pending',
      ...details,
      providerSessionIds: unconfirmed.map((stop) => stop.sessionId),
      causes: unconfirmed.map((stop) => stop.failure),
      ...(one
        ? {
            providerSessionId: one.sessionId,
            ...(one.runId === undefined ? {} : { runId: one.runId }),
            cause: one.failure,
          }
        : {}),
      hint: `End the Revyl session${one ? '' : 's'} ${ids}; each device stays rented and billed until it is.`,
    },
    cause,
  );
}

/** The start request once its session id is issued, which every readiness failure names. */
type RevylReadyInput = RevylStartRequestInput & Readonly<{ sessionId: string }>;

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
  input: RevylReadyInput,
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
  input: RevylReadyInput,
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
  input: RevylReadyInput,
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
  input: RevylReadyInput,
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
function requireTime(deadline: RevylDeadline, input: RevylReadyInput): void {
  if (Date.now() < deadline.at) return;
  // The budget is the caller's deadline when it is shorter, so the number named has to be the one that
  // actually ran out.
  throw revylCallerGaveUp(input.platform, input, deadline.budgetMs, input.sessionId);
}

/** The remaining readiness budget, so a poll that outlives it is canceled rather than awaited. */
function pollSignal(deadline: RevylDeadline, input: RevylReadyInput): AbortSignal {
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
 * Ends one Revyl session by the id this runtime issued for it. `/stop` is idempotent, so a repeat
 * release is safe; every rented session carries that id, so no run-level cancel is needed.
 */
export async function stopRevylSession(client: RevylClient, sessionId: string): Promise<void> {
  await client.stopDeviceSession(sessionId);
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
