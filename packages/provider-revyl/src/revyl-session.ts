import { AppError } from '@agent-device/kernel/errors';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { buildRevylDevice, REVYL_SNAPSHOT_CHANNEL, type RevylPlatform } from './device.ts';
import type { RevylClient } from './revyl-client.ts';
import type { RevylStartDeviceRequest, RevylWorkerHealth } from './revyl-types.ts';

/** How long Revyl may take to assign a worker and connect the device before the start is given up on. */
const READY_TIMEOUT_MS = 240_000;
/** Revyl's worker answers `health` with 503 until the device is attached; the CLI polls on that beat. */
const READY_POLL_INTERVAL_MS = 2_000;
/** Revyl releases an idle session on its own; this is the lease the runtime asks for. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30 * 60;

export type RevylScreenSize = Readonly<{ width: number; height: number }>;

/** One live Revyl session: the run its actions route to, and the session that ends it. */
export type RevylSession = Readonly<{
  platform: RevylPlatform;
  /** The device-proxy routing key every action path is built from. */
  runId: string;
  /** What Revyl's `/stop` endpoint takes; absent when the start returned none. */
  sessionId: string | undefined;
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
}>;

/**
 * Starts a Revyl device and waits until it answers: `start_device`, then the worker-connection poll,
 * then `health` until the device reports connected. A start that never became ready is stopped
 * before the failure reaches the caller, so a failed allocate never leaves a rented device running.
 */
export async function startRevylSession(
  client: RevylClient,
  lease: DeviceLease,
  input: RevylStartRequestInput,
): Promise<RevylSession> {
  const request: RevylStartDeviceRequest = {
    platform: input.platform,
    is_simulation: true,
    idle_timeout_seconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
    ...(input.appUrl === undefined ? {} : { app_url: input.appUrl }),
    ...(input.deviceModel === undefined ? {} : { device_model: input.deviceModel }),
    ...(input.osVersion === undefined ? {} : { os_version: input.osVersion }),
  };
  const started = await client.startDevice(request, input.signal);
  const runId = typeof started.workflow_run_id === 'string' ? started.workflow_run_id : undefined;
  if (!runId) {
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
  try {
    const health = await awaitRevylDeviceReady(client, runId, input);
    return {
      platform: input.platform,
      runId,
      sessionId: typeof started.session_id === 'string' ? started.session_id : undefined,
      screen: readRevylScreenSize(health),
      device: buildRevylDevice(input.platform, lease, runId),
      snapshotChannel: REVYL_SNAPSHOT_CHANNEL[input.platform],
      client,
      lease,
    };
  } catch (error) {
    await stopRevylSession(client, runId, started.session_id ?? undefined).catch(() => undefined);
    throw error;
  }
}

async function awaitRevylDeviceReady(
  client: RevylClient,
  runId: string,
  input: RevylStartRequestInput,
): Promise<RevylWorkerHealth> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  await untilRevylWorkerReady(client, runId, deadline, input);
  for (;;) {
    const response = await client.getWorkerHealth(runId, input.signal);
    if (response.device_connected === true) return response;
    if (Date.now() >= deadline) {
      throw new AppError(
        'COMMAND_FAILED',
        `Revyl did not connect a ${input.platform} device to run ${runId} within ${READY_TIMEOUT_MS} ms.`,
        {
          reason: 'provider-not-ready',
          runId,
          hint: 'Retry the command; Revyl may have had no device of that model available.',
        },
      );
    }
    await sleepBefore(deadline, input.signal);
  }
}

/** The worker-connection poll. `cancelled`, `stopped` and `failed` are terminal: no later poll is ready. */
async function untilRevylWorkerReady(
  client: RevylClient,
  runId: string,
  deadline: number,
  input: RevylStartRequestInput,
): Promise<void> {
  for (;;) {
    const connection = await client.getWorkerConnection(runId, input.signal);
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
    if (Date.now() >= deadline) {
      throw new AppError(
        'COMMAND_FAILED',
        `Revyl did not assign a worker for run ${runId} within ${READY_TIMEOUT_MS} ms.`,
        { reason: 'provider-not-ready', runId },
      );
    }
    await sleepBefore(deadline, input.signal);
  }
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
 * id is cancelled by its run instead — the same fallback Revyl's own clients take.
 */
export async function stopRevylSession(
  client: RevylClient,
  runId: string,
  sessionId: string | undefined,
): Promise<void> {
  if (sessionId) {
    await client.stopDeviceSession(sessionId);
    return;
  }
  await client.cancelDeviceRun(runId);
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
