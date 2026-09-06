import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runSimctl } from './core/apps-simctl.ts';
import { readSnapshotTargetProcessStartTime } from './snapshot-process.ts';

/** Identity re-check of a cached target: one local `ps`, never CoreSimulator IPC. */
const TARGET_IDENTITY_TIMEOUT_MS = 3_000;
/**
 * How long one capture waits for an in-flight discovery before taking the XCTest fallback.
 * Discovery spawns `simctl launchctl list` through xcrun: ~1s on an idle Mac, several seconds
 * on a loaded CI host. The wait is per capture, so captures that keep arriving while the probe
 * runs each spend up to this long; the probe itself is shared and outlives them.
 */
const TARGET_DISCOVERY_WAIT_MS = 1_500;
/** Overall deadline of one discovery (both simctl probes and the `ps` identity read). */
const TARGET_DISCOVERY_TIMEOUT_MS = 15_000;

export type SimulatorSnapshotTarget = Readonly<{
  udid: string;
  runtime: string;
  pid: number;
  generation: string;
  targetId: string;
  processStartTime: string;
}>;

export type SimulatorSnapshotTargetResolver = (
  device: DeviceInfo,
  appBundleId: string,
  signal: AbortSignal,
  refresh?: 'refresh',
) => Promise<SimulatorSnapshotTarget>;

export function createSimulatorSnapshotTargetResolver(): SimulatorSnapshotTargetResolver {
  const targets = new Map<string, SimulatorSnapshotTarget>();
  const discoveries = new Map<string, Promise<SimulatorSnapshotTarget>>();
  const runtimeByDevice = new Map<string, Promise<string>>();
  return async (device, appBundleId, signal, refresh) => {
    signal.throwIfAborted();
    const key = `${device.id}:${appBundleId}`;
    const cached = targets.get(key);
    if (cached && refresh !== 'refresh') {
      const observed = await readSnapshotTargetProcessStartTime(cached.pid, {
        signal,
        timeoutMs: TARGET_IDENTITY_TIMEOUT_MS,
      });
      if (observed === cached.processStartTime) return cached;
    }
    targets.delete(key);
    let discovery = discoveries.get(key);
    if (!discovery) {
      // One discovery per target at a time, detached from the caller's signal: a capture that
      // gives up on it, or is cancelled, must not take it down. A discovery that fails is
      // forgotten, so the next capture starts a new one.
      discovery = resolveSimulatorSnapshotTarget(device, appBundleId, runtimeByDevice)
        .then((target) => {
          targets.set(key, target);
          return target;
        })
        .finally(() => discoveries.delete(key));
      discovery.catch(() => undefined);
      discoveries.set(key, discovery);
    }
    return await awaitDiscovery(discovery, signal, device, appBundleId);
  };
}

async function awaitDiscovery(
  discovery: Promise<SimulatorSnapshotTarget>,
  signal: AbortSignal,
  device: DeviceInfo,
  appBundleId: string,
): Promise<SimulatorSnapshotTarget> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(targetError('simulator-target-discovery-pending', device, appBundleId)),
      TARGET_DISCOVERY_WAIT_MS,
    );
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([discovery, bound]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function resolveSimulatorSnapshotTarget(
  device: DeviceInfo,
  appBundleId: string,
  runtimeByDevice: Map<string, Promise<string>>,
): Promise<SimulatorSnapshotTarget> {
  const deadline = Date.now() + TARGET_DISCOVERY_TIMEOUT_MS;
  const [jobs, runtime] = await Promise.all([
    runSimctl(device, ['spawn', device.id, 'launchctl', 'list'], {
      allowFailure: true,
      timeoutMs: remainingMs(deadline),
    }),
    readSimulatorRuntime(device, runtimeByDevice, deadline),
  ]);
  if (jobs.exitCode !== 0) {
    throw targetError('simulator-target-probe-failed', device, appBundleId);
  }
  const job = readApplicationJob(jobs.stdout, appBundleId);
  if (!job) {
    throw targetError('simulator-target-unavailable', device, appBundleId);
  }
  const processStartTime = await readSnapshotTargetProcessStartTime(job.pid, {
    timeoutMs: Math.min(TARGET_IDENTITY_TIMEOUT_MS, remainingMs(deadline)),
  });
  if (!processStartTime) {
    throw targetError('simulator-target-identity-unavailable', device, appBundleId);
  }
  return Object.freeze({
    udid: device.id,
    runtime,
    pid: job.pid,
    generation: `${job.pid}:${job.label}:${processStartTime}`,
    targetId: `${device.id}:${appBundleId}`,
    processStartTime,
  });
}

async function readSimulatorRuntime(
  device: DeviceInfo,
  runtimeByDevice: Map<string, Promise<string>>,
  deadline: number,
): Promise<string> {
  const existing = runtimeByDevice.get(device.id);
  if (existing) return await existing;
  const pending = runSimctl(device, ['list', 'devices', '-j'], {
    allowFailure: true,
    timeoutMs: remainingMs(deadline),
  }).then((result) => {
    if (result.exitCode !== 0) throw targetError('simulator-runtime-probe-failed', device, '');
    const payload = JSON.parse(result.stdout) as {
      devices?: Record<string, Array<{ udid?: string }>>;
    };
    const runtime = Object.entries(payload.devices ?? {}).find(([, devices]) =>
      devices.some((candidate) => candidate.udid === device.id),
    )?.[0];
    if (!runtime) throw targetError('simulator-runtime-unavailable', device, '');
    return runtime;
  });
  runtimeByDevice.set(device.id, pending);
  try {
    return await pending;
  } catch (error) {
    runtimeByDevice.delete(device.id);
    throw error;
  }
}

function readApplicationJob(
  output: string,
  appBundleId: string,
): { pid: number; label: string } | undefined {
  for (const line of output.split('\n')) {
    const [pidText, , label] = line.trim().split(/\s+/);
    if (!pidText || !label || !label.startsWith(`UIKitApplication:${appBundleId}[`)) continue;
    const pid = Number(pidText);
    if (Number.isSafeInteger(pid) && pid > 0) return { pid, label };
  }
  return undefined;
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function targetError(reason: string, device: DeviceInfo, appBundleId: string): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Unable to resolve the running iOS Simulator app (${reason}).`,
    {
      reason,
      deviceId: device.id,
      appBundleId,
    },
  );
}
