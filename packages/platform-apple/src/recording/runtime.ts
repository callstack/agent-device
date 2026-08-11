import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { asAppError } from '@agent-device/kernel/errors';
import type {
  CleanupOutcome,
  RuntimeOwnerRef,
  ScreenRecordingRuntimeHost,
  ScreenRecordingLiveSnapshot,
  ScreenRecordingRuntimeOperations,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/platform';
import { PendingTransferGuard } from '@agent-device/contracts/platform';
import { createScreenRecordingLiveHandle } from '@agent-device/capture-kit';
import { completeAppleRecording as completion } from './completion.ts';
import {
  cleanupAppleRecording,
  createAppleRecordingEnvelope,
  reattachAppleRecording,
  type AppleRecordingDescriptor,
  type AppleScreenRecordingOperationHost,
} from './recovery.ts';
import { validateAppleSimulatorRecording } from './validation.ts';

export function appleScreenRecordingFacts(device: DeviceInfo) {
  if (device.appleOs === 'watchos')
    return unavailable('unsupported-platform-leaf', 'watchOS recording is not supported.');
  if (
    isIosFamily(device) &&
    device.kind === 'device' &&
    device.iosPhysicalDeviceBackend === 'xctest'
  ) {
    return unavailable(
      'unsupported-device-backend',
      'This command requires a CoreDevice-backed physical iOS device. The selected XCTest backend supports open, close, interactions, snapshots, and screenshots.',
    );
  }
  return Object.freeze({ available: true } as const);
}

export function createAppleScreenRecordingOperations(params: {
  host: AppleScreenRecordingOperationHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  signal: AbortSignal;
}): ScreenRecordingRuntimeOperations {
  const { host, device, owner, signal } = params;
  return Object.freeze({
    screenRecordingStart: async (input) =>
      await startAppleRecording({ host, device, owner, input, signal }),
    screenRecordingReattach: async (input) =>
      await reattachAppleRecording(host, device, input.envelope.descriptor.body),
    screenRecordingCleanup: async (input) =>
      await cleanupAppleRecording(host, device, input.envelope.descriptor.body),
  } satisfies ScreenRecordingRuntimeOperations);
}

type AppleRecordingStartParams = Readonly<{
  host: AppleScreenRecordingOperationHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  signal: AbortSignal;
}>;

async function startAppleRecording(params: AppleRecordingStartParams) {
  params.signal.throwIfAborted();
  return params.device.kind === 'simulator'
    ? await startAppleSimulatorRecording(params)
    : await startAppleRunnerRecording(params);
}

async function startAppleSimulatorRecording(params: AppleRecordingStartParams) {
  const { host, device, owner, input, signal } = params;
  await validateAppleSimulatorRecording(device, input, host.screenRecording.apple.isRunnerBundleId);
  const clockAnchor = input.activeSessionApp
    ? await host.screenRecording.apple.captureClockAnchor(
        device,
        input.activeSessionApp.bundleId,
        signal,
      )
    : undefined;
  await host.screenRecording.outputs.prepare(input.outputPath);
  const nativeProcess = await host.screenRecording.apple.startSimulator(
    device,
    input.outputPath,
    signal,
  );
  const processes = nativeProcess.markers;
  if (!processes || processes.length === 0) {
    await settleAppleSimulatorProcess(nativeProcess).catch(() => {});
    throw new Error('simctl recordVideo did not expose durable process identity');
  }
  try {
    signal.throwIfAborted();
  } catch (error) {
    await settleAppleSimulatorProcess(nativeProcess).catch(() => {});
    throw error;
  }
  return startResult({
    device,
    owner,
    input,
    descriptor: { backend: 'simctl', outputPath: input.outputPath, processes },
    snapshot: snapshot(input, 'simctl recordVideo', {}, clockAnchor),
    finish: async (current) => {
      await nativeProcess.terminate();
      const result = await nativeProcess.wait;
      if (result.exitCode !== 0) {
        throw new Error(`simctl recordVideo exited with code ${result.exitCode}`);
      }
      return await completion(host, current, 'iOS recording');
    },
    cleanup: async () => await cleanupAppleSimulatorProcess(nativeProcess),
  });
}

async function startAppleRunnerRecording(params: AppleRecordingStartParams) {
  const { host, device, owner, input, signal } = params;
  const appBundleId = input.activeSessionApp?.bundleId;
  if (!appBundleId) {
    throw new TypeError('Apple runner recording requires an active app session identity');
  }
  await host.screenRecording.outputs.prepare(input.outputPath);
  const result = await host.screenRecording.apple.runRunner(
    device,
    {
      kind: 'start',
      appBundleId,
      outputPath: input.outputPath,
      ...(input.fps === undefined ? {} : { fps: input.fps }),
    },
    signal,
  );
  if (!result.runnerSessionId || !result.runnerAuthority) {
    throw new Error('Apple runner recording did not expose durable session ownership');
  }
  const runnerOwnership = {
    runnerSessionId: result.runnerSessionId,
    runnerAuthority: result.runnerAuthority,
  } as const;
  let runnerStop: Promise<void> | undefined;
  const stopRunner = () =>
    (runnerStop ??= runAppleRecordingOperation(() =>
      host.screenRecording.apple
        .runRunner(device, { kind: 'stop', appBundleId, ...runnerOwnership })
        .then(() => undefined),
    ));
  if (!runnerDescriptorMatchesDevice(device, result.remotePath)) {
    await stopRunner().catch(() => {});
    throw new Error('Apple runner recording did not expose coherent durable media ownership');
  }
  try {
    signal.throwIfAborted();
  } catch (error) {
    await stopRunner().catch(() => {});
    throw error;
  }
  return startResult({
    device,
    owner,
    input,
    descriptor: {
      backend: 'runner',
      outputPath: input.outputPath,
      appBundleId,
      ...runnerOwnership,
      ...(result.remotePath === undefined ? {} : { remotePath: result.remotePath }),
    },
    snapshot: snapshot(input, 'runner AVAssetWriter', result),
    finish: async (current) => {
      await stopRunner();
      if (result.remotePath !== undefined) {
        await host.screenRecording.apple.retrieveRunnerRecording(
          device,
          result.remotePath,
          current.outPath,
        );
      }
      return await completion(
        host,
        current,
        device.appleOs === 'macos' ? 'macOS recording' : 'iOS recording',
      );
    },
    cleanup: async () => {
      await stopRunner();
      return { status: 'cleaned' } as const;
    },
  });
}

async function runAppleRecordingOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw asAppError(error, 'COMMAND_FAILED');
  }
}

function runnerDescriptorMatchesDevice(
  device: DeviceInfo,
  remotePath: string | undefined,
): boolean {
  if (device.appleOs === 'macos') return remotePath === undefined;
  if (!isIosFamily(device)) return remotePath === undefined;
  return remotePath !== undefined && /^tmp\/agent-device-recording-\d+\.mp4$/.test(remotePath);
}

async function settleAppleSimulatorProcess(
  nativeProcess: Awaited<ReturnType<ScreenRecordingRuntimeHost['apple']['startSimulator']>>,
) {
  await nativeProcess.terminate();
  return await nativeProcess.wait;
}

async function cleanupAppleSimulatorProcess(
  nativeProcess: Awaited<ReturnType<ScreenRecordingRuntimeHost['apple']['startSimulator']>>,
): Promise<CleanupOutcome> {
  try {
    await settleAppleSimulatorProcess(nativeProcess);
    return { status: 'cleaned' };
  } catch (error) {
    return {
      status: 'cleanup-pending',
      reason: 'transport-failed',
      message: error instanceof Error ? error.message : 'Apple simulator cleanup failed',
    };
  }
}

function startResult(params: {
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  descriptor: AppleRecordingDescriptor;
  snapshot: ScreenRecordingLiveSnapshot;
  finish(snapshot: ScreenRecordingLiveSnapshot): ReturnType<typeof completion>;
  cleanup(): Promise<CleanupOutcome>;
}) {
  const { device, owner, input, descriptor, snapshot, finish, cleanup } = params;
  const handle = createScreenRecordingLiveHandle(snapshot, {
    finish,
    forceCleanup: cleanup,
  });
  return Object.freeze({
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createAppleRecordingEnvelope({ device, owner, input, descriptor }),
  });
}

function snapshot(
  input: ScreenRecordingStartInput,
  backend: string,
  timing: Readonly<{
    recorderStartUptimeMs?: number;
    targetAppReadyUptimeMs?: number;
    runnerSessionId?: string;
  }> = {},
  clockAnchor?: Readonly<{ wallClockAtMs: number; uptimeMs: number }>,
): ScreenRecordingLiveSnapshot {
  const startedAt = Date.now();
  return Object.freeze({
    backend,
    outPath: input.outputPath,
    ...(input.clientOutputPath === undefined ? {} : { clientOutPath: input.clientOutputPath }),
    startedAt,
    scope: input.scope,
    showTouches: input.showTouches,
    recordOnlySession: input.recordOnlySession,
    ...(input.activeSessionApp === undefined ? {} : { activeSessionApp: input.activeSessionApp }),
    ...(input.exportQuality === undefined ? {} : { exportQuality: input.exportQuality }),
    gestureEvents: [],
    ...(clockAnchor === undefined
      ? {}
      : {
          gestureClockOriginAtMs: clockAnchor.wallClockAtMs,
          gestureClockOriginUptimeMs: clockAnchor.uptimeMs,
        }),
    ...(timing.recorderStartUptimeMs === undefined
      ? {}
      : {
          gestureClockOriginAtMs: startedAt,
          gestureClockOriginUptimeMs: timing.recorderStartUptimeMs,
          runnerStartedAtUptimeMs: timing.recorderStartUptimeMs,
        }),
    ...(timing.targetAppReadyUptimeMs === undefined
      ? {}
      : { targetAppReadyUptimeMs: timing.targetAppReadyUptimeMs }),
    ...(timing.runnerSessionId === undefined ? {} : { runnerSessionId: timing.runnerSessionId }),
  });
}

function unavailable(
  reason: 'unsupported-platform-leaf' | 'unsupported-device-backend',
  hint: string,
) {
  return Object.freeze({ available: false, reason, hint } as const);
}
