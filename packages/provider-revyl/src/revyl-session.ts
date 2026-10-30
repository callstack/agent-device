import { AppError } from '@agent-device/kernel/errors';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { buildRevylDevice, REVYL_SNAPSHOT_CHANNEL, type RevylPlatform } from './device.ts';
import type { RevylClient } from './revyl-client.ts';
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
  const started = await submitRevylStart(client, request, input);
  const runId = typeof started.workflow_run_id === 'string' ? started.workflow_run_id : undefined;
  // Every later stop addresses the session by the id the runtime issued, and an expired-lease
  // recovery in another process derives that same id from the lease. A backend that kept its own
  // identity for the session therefore has to be refused rather than half-supported: its run is
  // canceled, since that is the one handle that still names the device.
  const echoed = typeof started.session_id === 'string' ? started.session_id : undefined;
  if (runId && echoed && echoed !== sessionId) {
    await stopOrReport(client, runId, undefined);
    throw new AppError(
      'COMMAND_FAILED',
      `Revyl started the device as session ${echoed} instead of ${sessionId}.`,
      {
        reason: 'provider-session-identity-mismatch',
        runId,
        providerSessionId: echoed,
        hint: 'Retry the command; agent-device ends a Revyl session by the identity it issued.',
      },
    );
  }
  if (!runId) {
    await stopOrReport(client, undefined, sessionId);
    throw new AppError(
      'COMMAND_FAILED',
      `Revyl did not start a ${input.platform} device: ${started.error ?? started.message ?? 'no workflow run was returned'}`,
      {
        reason: 'provider-start-refused',
        platform: input.platform,
        ...(started.trace_id === undefined ? {} : { traceId: started.trace_id }),
      },
    );
  }
  // Revyl may have answered a run for a start the caller already gave up on. That device is rented
  // either way, so it is stopped here before the cancellation reaches the caller.
  if (input.signal?.aborted) {
    await stopOrReport(client, runId, sessionId);
    throw startCanceled(input);
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
    };
  } catch (error) {
    throw await cleanupAfterFailedStart(client, runId, sessionId, error);
  }
}

/**
 * Sends `start_device` and waits for the answer, without the caller's cancellation on it. The start
 * rents a device, so a caller that hangs up before the answer would leave a run whose id nobody
 * recorded; the request is bounded by the client's own start timeout instead, and the abandoned
 * start is stopped once its answer arrives.
 */
async function submitRevylStart(
  client: RevylClient,
  request: RevylStartDeviceRequest,
  input: RevylStartRequestInput,
): Promise<RevylStartDeviceResponse> {
  if (input.deadline !== undefined && input.deadline - Date.now() <= 0) throw startCanceled(input);
  try {
    return await client.startDevice(request);
  } catch (error) {
    if (input.signal?.aborted) throw startCanceled(input);
    throw error;
  }
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
 * Ends the session a failed start left behind and reports whether it succeeded. A stop that failed
 * keeps the rented device running with no session anyone holds, so the failure the caller sees names
 * the session that still has to be ended.
 */
async function cleanupAfterFailedStart(
  client: RevylClient,
  runId: string,
  sessionId: string,
  error: unknown,
): Promise<unknown> {
  if (error instanceof AppError && error.details?.reason === 'request_canceled') {
    await stopOrReport(client, runId, sessionId);
    return error;
  }
  try {
    await stopRevylSession(client, runId, sessionId);
    return error;
  } catch (cleanupError) {
    return new AppError(
      'COMMAND_FAILED',
      `Revyl did not start a ready device, and the session it rented (${sessionId}) is still running.`,
      {
        reason: 'provider-cleanup-pending',
        runId,
        providerSessionId: sessionId,
        cause: describe(cleanupError),
        hint: `End the Revyl session ${sessionId}; the device stays rented and billed until it is.`,
      },
      error,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stops what the start created and reports a failure instead of swallowing it: a caller that cannot
 * reach Revyl has to hear that the device it asked for was not released.
 */
async function stopOrReport(
  client: RevylClient,
  runId: string | undefined,
  sessionId: string | undefined,
) {
  try {
    await stopRevylSession(client, runId, sessionId);
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Revyl did not release the session it started (${sessionId}).`,
      {
        reason: 'provider-cleanup-pending',
        providerSessionId: sessionId,
        ...(runId === undefined ? {} : { runId }),
        cause: describe(error),
        hint: `End the Revyl session ${sessionId}; the device stays rented and billed until it is.`,
      },
      error,
    );
  }
}

/** The caller's own budget wins when it is shorter, so a start never outlives the lease request. */
function readinessDeadline(input: RevylStartRequestInput): number {
  const own = Date.now() + READY_TIMEOUT_MS;
  return input.deadline === undefined ? own : Math.min(own, input.deadline);
}

async function awaitRevylDeviceReady(
  client: RevylClient,
  runId: string,
  deadline: number,
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
  deadline: number,
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
  deadline: number,
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
  deadline: number,
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
function requireTime(deadline: number, input: RevylStartRequestInput): void {
  if (Date.now() < deadline) return;
  if (input.signal?.aborted) throw startCanceled(input);
  throw new AppError(
    'COMMAND_FAILED',
    `Revyl did not report a ready device within ${READY_TIMEOUT_MS} ms.`,
    {
      reason: 'provider-not-ready',
      hint: 'Retry the command; Revyl may have had no device of that model available.',
    },
  );
}

/** The remaining readiness budget, so a poll that outlives it is canceled rather than awaited. */
function pollSignal(deadline: number, input: RevylStartRequestInput): AbortSignal {
  const remaining = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
  return input.signal === undefined ? remaining : AbortSignal.any([input.signal, remaining]);
}

async function sleepBefore(deadline: number, signal?: AbortSignal): Promise<void> {
  await sleep(
    Math.min(READY_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
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
