import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runSimctl } from './core/apps-simctl.ts';
import { readSnapshotTargetProcessStartTime } from './snapshot-process.ts';

const TARGET_PROBE_TIMEOUT_MS = 3_000;

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
  const runtimeByDevice = new Map<string, Promise<string>>();
  return async (device, appBundleId, signal, refresh) => {
    signal.throwIfAborted();
    const key = `${device.id}:${appBundleId}`;
    const cached = targets.get(key);
    if (cached && refresh !== 'refresh') {
      const observed = await readSnapshotTargetProcessStartTime(cached.pid, {
        signal,
        timeoutMs: TARGET_PROBE_TIMEOUT_MS,
      });
      if (observed === cached.processStartTime) return cached;
    }
    targets.delete(key);
    const target = await resolveSimulatorSnapshotTarget(
      device,
      appBundleId,
      signal,
      runtimeByDevice,
    );
    targets.set(key, target);
    return target;
  };
}

async function resolveSimulatorSnapshotTarget(
  device: DeviceInfo,
  appBundleId: string,
  signal: AbortSignal,
  runtimeByDevice: Map<string, Promise<string>>,
): Promise<SimulatorSnapshotTarget> {
  const [jobs, runtime] = await Promise.all([
    runSimctl(device, ['spawn', device.id, 'launchctl', 'list'], {
      allowFailure: true,
      signal,
      timeoutMs: TARGET_PROBE_TIMEOUT_MS,
    }),
    readSimulatorRuntime(device, signal, runtimeByDevice),
  ]);
  if (jobs.exitCode !== 0) {
    throw targetError('simulator-target-probe-failed', device, appBundleId);
  }
  const job = readApplicationJob(jobs.stdout, appBundleId);
  if (!job) {
    throw targetError('simulator-target-unavailable', device, appBundleId);
  }
  const processStartTime = await readSnapshotTargetProcessStartTime(job.pid, {
    signal,
    timeoutMs: TARGET_PROBE_TIMEOUT_MS,
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
  signal: AbortSignal,
  runtimeByDevice: Map<string, Promise<string>>,
): Promise<string> {
  const existing = runtimeByDevice.get(device.id);
  if (existing) return await existing;
  const pending = runSimctl(device, ['list', 'devices', '-j'], {
    allowFailure: true,
    signal,
    timeoutMs: TARGET_PROBE_TIMEOUT_MS,
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

function targetError(reason: string, device: DeviceInfo, appBundleId: string): AppError {
  return new AppError('COMMAND_FAILED', 'Unable to resolve the running iOS Simulator app.', {
    reason,
    deviceId: device.id,
    appBundleId,
  });
}
