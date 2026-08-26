import path from 'node:path';
import type { ManagedProcessOwnership } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createScopedProvider } from './utils/scoped-provider.ts';
import { isProcessAlive } from './utils/host-process.ts';

type AppleRunnerScreenRecordingStartRequest = Readonly<{
  device: DeviceInfo;
  appBundleId: string;
  outputPath: string;
  fps?: number;
  signal?: AbortSignal;
}>;

type AppleRunnerScreenRecordingStartResult = Readonly<{
  runnerSessionId: string;
  remotePath?: string;
  recorderStartUptimeMs?: number;
  targetAppReadyUptimeMs?: number;
}>;

export type AppleRunnerScreenRecordingTransport = Readonly<{
  authority: 'local-lease' | 'scoped-provider';
  available: boolean;
  start(
    request: AppleRunnerScreenRecordingStartRequest,
  ): Promise<AppleRunnerScreenRecordingStartResult>;
  inspect(device: DeviceInfo, runnerSessionId: string): Promise<ManagedProcessOwnership>;
  stop(
    request: Readonly<{
      device: DeviceInfo;
      runnerSessionId: string;
      appBundleId?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<void>;
}>;

const localTransport: AppleRunnerScreenRecordingTransport = Object.freeze({
  authority: 'local-lease',
  available: true,
  start: startLocalAppleRunnerRecording,
  inspect: async (device, runnerSessionId) => await inspectLocalRunner(device, runnerSessionId),
  stop: async ({ device, runnerSessionId, appBundleId, signal }) => {
    const { runAppleRunnerCommand } = await import('./platforms/apple/core/runner-client.ts');
    await runAppleRunnerCommand(
      device,
      { command: 'recordStop', appBundleId },
      { signal, expectedRunnerSessionId: runnerSessionId },
    );
  },
});

async function startLocalAppleRunnerRecording({
  device,
  appBundleId,
  outputPath,
  fps,
  signal,
}: AppleRunnerScreenRecordingStartRequest): Promise<AppleRunnerScreenRecordingStartResult> {
  const { getRunnerSessionSnapshot, runAppleRunnerCommand } =
    await import('./platforms/apple/core/runner-client.ts');
  const recordingFileName = `agent-device-recording-${Date.now()}.mp4`;
  const remotePath =
    device.appleOs === 'macos' || device.kind !== 'device' ? undefined : `tmp/${recordingFileName}`;
  const result = await runAppleRunnerCommand(
    device,
    {
      command: 'recordStart',
      outPath: runnerOutputPath(device, outputPath, recordingFileName, remotePath),
      ...(fps === undefined ? {} : { fps }),
      appBundleId,
    },
    { signal },
  );
  const session = getRunnerSessionSnapshot(device.id);
  if (!session?.alive) {
    throw new Error('Apple runner recording did not expose a durable runner session identity');
  }
  try {
    signal?.throwIfAborted();
  } catch (error) {
    await runAppleRunnerCommand(
      device,
      { command: 'recordStop', appBundleId },
      { expectedRunnerSessionId: session.sessionId },
    ).catch(() => {});
    throw error;
  }
  return freezeRunnerStartResult(session.sessionId, remotePath, result);
}

function runnerOutputPath(
  device: DeviceInfo,
  outputPath: string,
  recordingFileName: string,
  remotePath: string | undefined,
): string {
  if (device.appleOs === 'macos') return outputPath;
  return remotePath === undefined ? path.basename(outputPath) : recordingFileName;
}

function freezeRunnerStartResult(
  runnerSessionId: string,
  remotePath: string | undefined,
  timing: Readonly<{ recorderStartUptimeMs?: unknown; targetAppReadyUptimeMs?: unknown }>,
): AppleRunnerScreenRecordingStartResult {
  return Object.freeze({
    runnerSessionId,
    ...(remotePath === undefined ? {} : { remotePath }),
    ...(typeof timing.recorderStartUptimeMs === 'number'
      ? { recorderStartUptimeMs: timing.recorderStartUptimeMs }
      : {}),
    ...(typeof timing.targetAppReadyUptimeMs === 'number'
      ? { targetAppReadyUptimeMs: timing.targetAppReadyUptimeMs }
      : {}),
  });
}

const unavailableScopedTransport: AppleRunnerScreenRecordingTransport = Object.freeze({
  authority: 'scoped-provider',
  available: false,
  start: async () => {
    throw new Error('Scoped Apple runner provider does not expose durable recording authority');
  },
  inspect: async () => 'ownership-lost' as const,
  stop: async () => {
    throw new Error('Scoped Apple runner recording authority is unavailable');
  },
});

const transportScope = createScopedProvider(localTransport);

export function resolveAppleRunnerScreenRecordingTransport(): AppleRunnerScreenRecordingTransport {
  return transportScope.resolve();
}

export async function withAppleRunnerScreenRecordingTransport<T>(
  transport: AppleRunnerScreenRecordingTransport | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return await transportScope.run(transport ?? unavailableScopedTransport, task);
}

async function inspectLocalRunner(
  device: DeviceInfo,
  runnerSessionId: string,
): Promise<ManagedProcessOwnership> {
  const { getRunnerSessionSnapshot, readStaleRunnerLease, verifyLeaseRunnerPidIdentity } =
    await import('./platforms/apple/core/runner-client.ts');
  const active = getRunnerSessionSnapshot(device.id);
  if (active) {
    if (!active.alive) return 'missing';
    return active.sessionId === runnerSessionId ? 'owned-alive' : 'ownership-lost';
  }
  const lease = readStaleRunnerLease(device.id);
  if (!lease) return 'missing';
  if (lease.sessionId !== runnerSessionId) return 'ownership-lost';
  if (lease.runnerPid === null || !isProcessAlive(lease.runnerPid)) return 'missing';
  return verifyLeaseRunnerPidIdentity(lease, lease.runnerPid) ? 'owned-alive' : 'ownership-lost';
}
