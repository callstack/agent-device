import { randomUUID } from 'node:crypto';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  CleanupOutcome,
  PlatformRuntimeHost,
  RuntimeOwnerRef,
  ScreenRecordingRuntimeHost,
  ScreenRecordingLiveSnapshot,
  ScreenRecordingRuntimeOperations,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/platform';
import { PendingTransferGuard } from '@agent-device/contracts/platform';
import {
  createScreenRecordingCompletion,
  createScreenRecordingLiveHandle,
  assertScreenRecordingOptionsSupported,
} from '@agent-device/capture-kit';
import {
  cleanupRecoveredHarmonyRecording,
  createHarmonyRecordingEnvelope,
  type HarmonyRecordingDescriptor,
} from './recovery.ts';

type HarmonyScreenRecordingOperationHost = Readonly<{
  screenRecording: Pick<ScreenRecordingRuntimeHost, 'harmony' | 'finalize' | 'outputs'>;
  clock: PlatformRuntimeHost['clock'];
}>;

export function harmonyScreenRecordingFacts(device: DeviceInfo) {
  return device.kind === 'device'
    ? Object.freeze({ available: true } as const)
    : Object.freeze({
        available: false,
        reason: 'unsupported-device-kind',
        hint: 'HarmonyOS recording is supported on physical devices only.',
      } as const);
}

export function createHarmonyScreenRecordingOperations(params: {
  host: HarmonyScreenRecordingOperationHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  signal: AbortSignal;
}): ScreenRecordingRuntimeOperations {
  const { host, device, owner, signal } = params;
  return Object.freeze({
    screenRecordingStart: async (input) =>
      await startHarmonyRecording({ host, device, owner, input, signal }),
    screenRecordingReattach: async () => ({
      status: 'unreattachable' as const,
      reason: 'transport-not-reattachable' as const,
      message: 'HarmonyOS recordings cannot be reattached after daemon restart.',
    }),
    screenRecordingCleanup: async (input) =>
      cleanupRecoveredHarmonyRecording(input.envelope.descriptor.body),
  } satisfies ScreenRecordingRuntimeOperations);
}

async function startHarmonyRecording(params: {
  host: HarmonyScreenRecordingOperationHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  signal: AbortSignal;
}) {
  const { host, device, owner, input, signal } = params;
  if (input.scope === 'app') {
    throw new AppError(
      'INVALID_ARGS',
      'HarmonyOS recording captures the whole physical-device screen; use --scope device or --scope system',
    );
  }
  assertScreenRecordingOptionsSupported(
    input,
    { scopes: ['device', 'system'], fps: false, exportQuality: false, hideTouches: false },
    (unsupported) => `HarmonyOS recordings do not support ${unsupported.join(', ')}`,
  );
  signal.throwIfAborted();
  await host.screenRecording.outputs.prepare(input.outputPath);
  const fileName = `agent-device-recording-${randomUUID()}.mp4`;
  const remotePath = `/data/local/tmp/${fileName}`;
  const descriptor = {
    backend: 'harmony-screen-recorder' as const,
    fileName,
    remotePath,
  };
  let start;
  try {
    start = await host.screenRecording.harmony.start(device, fileName, signal);
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) {
      await cleanupLiveHarmonyDescriptor(host, device, descriptor).catch(() => {});
      throw signal.reason;
    }
    throw error;
  }
  assertHarmonyRecorderCommandSucceeded(start, 'start');
  try {
    signal.throwIfAborted();
  } catch (error) {
    await cleanupLiveHarmonyDescriptor(host, device, descriptor).catch(() => {});
    throw error;
  }
  const initial = snapshot(input);
  let recorderStopped = false;
  const stopRecorder = async () => {
    if (recorderStopped) return;
    const stop = await host.screenRecording.harmony.stop(device);
    assertHarmonyRecorderCommandSucceeded(stop, 'stop');
    recorderStopped = true;
  };
  const handle = createScreenRecordingLiveHandle(initial, {
    finish: async (current) =>
      await finishHarmonyRecording(host, device, current, descriptor, stopRecorder),
    forceCleanup: async () =>
      await cleanupLiveHarmonyDescriptor(host, device, descriptor, stopRecorder),
  });
  return Object.freeze({
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createHarmonyRecordingEnvelope({ device, owner, input, descriptor }),
  });
}

function snapshot(input: ScreenRecordingStartInput): ScreenRecordingLiveSnapshot {
  return Object.freeze({
    backend: 'HarmonyOS ScreenRecorder',
    outPath: input.outputPath,
    ...(input.clientOutputPath === undefined ? {} : { clientOutPath: input.clientOutputPath }),
    startedAt: Date.now(),
    scope: input.scope,
    showTouches: false,
    recordOnlySession: input.recordOnlySession,
    ...(input.activeSessionApp === undefined ? {} : { activeSessionApp: input.activeSessionApp }),
    gestureEvents: [],
  });
}

async function finishHarmonyRecording(
  host: HarmonyScreenRecordingOperationHost,
  device: DeviceInfo,
  snapshot: ScreenRecordingLiveSnapshot,
  descriptor: HarmonyRecordingDescriptor,
  stopRecorder: () => Promise<void>,
) {
  await stopRecorder();
  const mediaUri = await host.screenRecording.harmony.findMedia(device, descriptor.fileName);
  if (!mediaUri)
    throw new Error(`failed to find finalized HarmonyOS recording '${descriptor.fileName}'`);
  const staged = await stageHarmonyMedia(host, device, descriptor, mediaUri);
  if (!staged) {
    throw new Error(
      `failed to finalize HarmonyOS recording: ${descriptor.fileName} did not produce a non-empty media file`,
    );
  }
  let completed = false;
  try {
    const pulled = await host.screenRecording.harmony.pull(device, {
      remotePath: descriptor.remotePath,
      outputPath: snapshot.outPath,
    });
    if (pulled.exitCode !== 0) throw new Error('failed to retrieve HarmonyOS recording');
    const finalization = await host.screenRecording.finalize.complete({
      outputPath: snapshot.outPath,
      showTouches: false,
      gestureEvents: snapshot.gestureEvents,
      targetLabel: 'HarmonyOS recording',
    });
    completed = true;
    return createScreenRecordingCompletion(snapshot, finalization, false);
  } finally {
    await host.screenRecording.harmony.remove(device, descriptor.remotePath).catch(() => {});
    if (completed) {
      await host.screenRecording.harmony.removeMedia(device, mediaUri).catch(() => {});
    }
  }
}

async function stageHarmonyMedia(
  host: HarmonyScreenRecordingOperationHost,
  device: DeviceInfo,
  descriptor: HarmonyRecordingDescriptor,
  mediaUri: string,
): Promise<boolean> {
  let previousNonzeroSize: number | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await host.screenRecording.harmony.remove(device, descriptor.remotePath).catch(() => {});
    const staged = await host.screenRecording.harmony.stageMedia(device, {
      mediaUri,
      remotePath: descriptor.remotePath,
    });
    if (staged) {
      const size = await host.screenRecording.harmony.stagedFileSize(device, descriptor.remotePath);
      if (size !== undefined && size > 0 && size === previousNonzeroSize) return true;
      previousNonzeroSize = size !== undefined && size > 0 ? size : undefined;
    } else {
      previousNonzeroSize = undefined;
    }
    if (attempt < 39) await host.clock.sleep(250);
  }
  return false;
}

async function cleanupLiveHarmonyDescriptor(
  host: HarmonyScreenRecordingOperationHost,
  device: DeviceInfo,
  descriptor: HarmonyRecordingDescriptor,
  stopRecorder: () => Promise<void> = async () => {
    const stop = await host.screenRecording.harmony.stop(device);
    assertHarmonyRecorderCommandSucceeded(stop, 'stop');
  },
): Promise<CleanupOutcome> {
  const failures = [
    await cleanupFailure(stopRecorder),
    await cleanupFailure(async () => {
      if (!(await host.screenRecording.harmony.remove(device, descriptor.remotePath))) {
        throw new Error('HarmonyOS recording staging artifact removal was not confirmed');
      }
    }),
    await cleanupFailure(async () => await removeHarmonyMedia(host, device, descriptor.fileName)),
  ];
  const failure = failures.find((candidate) => candidate !== undefined);
  if (failure !== undefined) {
    return {
      status: 'cleanup-pending',
      reason: 'transport-failed',
      message: failure instanceof Error ? failure.message : 'HarmonyOS recording cleanup failed',
    };
  }
  return { status: 'cleaned' };
}

async function removeHarmonyMedia(
  host: HarmonyScreenRecordingOperationHost,
  device: DeviceInfo,
  fileName: string,
): Promise<void> {
  const mediaUri = await host.screenRecording.harmony.findMedia(device, fileName);
  if (mediaUri && !(await host.screenRecording.harmony.removeMedia(device, mediaUri))) {
    throw new Error('HarmonyOS recording media removal was not confirmed');
  }
}

async function cleanupFailure(action: () => Promise<void>): Promise<unknown | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
}

function assertHarmonyRecorderCommandSucceeded(
  result: Readonly<{ exitCode: number | null; stdout: string; stderr: string }>,
  action: 'start' | 'stop',
): void {
  if (result.exitCode === 0 && result.stdout.includes('start ability successfully')) return;
  const output = result.stdout.trim() || result.stderr.trim() || `hdc exit ${result.exitCode}`;
  throw new Error(`failed to ${action} HarmonyOS screen recording: ${output}`);
}
