import { randomUUID } from 'node:crypto';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { CleanupOutcome } from '@agent-device/contracts/durable-resource';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type {
  ScreenRecordingLiveSnapshot,
  ScreenRecordingRuntimeOperations,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/screen-recording-runtime';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import {
  createScreenRecordingCompletion,
  createScreenRecordingLiveHandle,
  assertScreenRecordingOptionsSupported,
} from '@agent-device/capture-kit';
import { createTransportRecordingSnapshot } from '@agent-device/capture-kit/screen-recording-transport';
import {
  cleanupRecoveredHarmonyRecording,
  createHarmonyRecordingEnvelope,
  type HarmonyRecordingDescriptor,
} from './recovery.ts';
import { createHarmonyScreenRecorder, type HarmonyScreenRecorder } from './recorder.ts';
import type { HarmonyToolbox } from '../toolbox.ts';

const HARMONY_SCREEN_RECORDING_BACKEND = 'HarmonyOS ScreenRecorder';

/**
 * The host the HarmonyOS recording operations consume: output preparation and video finalization
 * from the shared runtime host, plus the HDC recorder this family drives. The recorder is part of
 * the seam rather than a shared host facet, because no other family uses it.
 */
export type HarmonyScreenRecordingOperationHost = Readonly<{
  screenRecording: Pick<PlatformRuntimeHost['screenRecording'], 'finalize' | 'outputs'>;
  clock: PlatformRuntimeHost['clock'];
  recorder: HarmonyScreenRecorder;
}>;

/** Binds the shared runtime host's recording authorities to the HDC recorder this family drives. */
export function createHarmonyRecordingHost(
  host: PlatformRuntimeHost,
  toolbox: HarmonyToolbox,
): HarmonyScreenRecordingOperationHost {
  return Object.freeze({
    screenRecording: host.screenRecording,
    clock: host.clock,
    recorder: createHarmonyScreenRecorder(toolbox.hdc),
  });
}

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
  const { recorder } = host;
  return Object.freeze({
    screenRecordingStart: async (input) =>
      await startHarmonyRecording({ host, recorder, device, owner, input, signal }),
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
  recorder: HarmonyScreenRecorder;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  signal: AbortSignal;
}) {
  const { host, recorder, device, owner, input, signal } = params;
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
    start = await recorder.start(device, fileName, signal);
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) {
      await cleanupLiveHarmonyDescriptor(recorder, device, descriptor).catch(() => {});
      throw signal.reason;
    }
    throw error;
  }
  assertHarmonyRecorderCommandSucceeded(start, 'start');
  try {
    signal.throwIfAborted();
  } catch (error) {
    await cleanupLiveHarmonyDescriptor(recorder, device, descriptor).catch(() => {});
    throw error;
  }
  const initial = createTransportRecordingSnapshot(HARMONY_SCREEN_RECORDING_BACKEND, input);
  let recorderStopped = false;
  const stopRecorder = async () => {
    if (recorderStopped) return;
    const stop = await recorder.stop(device);
    assertHarmonyRecorderCommandSucceeded(stop, 'stop');
    recorderStopped = true;
  };
  const handle = createScreenRecordingLiveHandle(initial, {
    finish: async (current) =>
      await finishHarmonyRecording(host, recorder, device, current, descriptor, stopRecorder),
    forceCleanup: async () =>
      await cleanupLiveHarmonyDescriptor(recorder, device, descriptor, stopRecorder),
  });
  return Object.freeze({
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createHarmonyRecordingEnvelope({ device, owner, input, descriptor }),
  });
}

async function finishHarmonyRecording(
  host: HarmonyScreenRecordingOperationHost,
  recorder: HarmonyScreenRecorder,
  device: DeviceInfo,
  snapshot: ScreenRecordingLiveSnapshot,
  descriptor: HarmonyRecordingDescriptor,
  stopRecorder: () => Promise<void>,
) {
  await stopRecorder();
  const mediaUri = await recorder.findMedia(device, descriptor.fileName);
  if (!mediaUri)
    throw new Error(`failed to find finalized HarmonyOS recording '${descriptor.fileName}'`);
  const staged = await stageHarmonyMedia(host, recorder, device, descriptor, mediaUri);
  if (!staged) {
    throw new Error(
      `failed to finalize HarmonyOS recording: ${descriptor.fileName} did not produce a non-empty media file`,
    );
  }
  try {
    const pulled = await recorder.pull(device, {
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
    const cleanupWarning = await cleanupCompletedHarmonyArtifacts(
      recorder,
      device,
      descriptor,
      mediaUri,
    );
    return createScreenRecordingCompletion(
      snapshot,
      {
        ...finalization,
        ...appendCompletionWarning(finalization.warning, cleanupWarning),
      },
      {
        // One `aa start` toggle was acknowledged for this session's own recorder, and `mediatool`
        // reported the finalized item it left behind.
        stopObservation: { recorder: 'confirmed' },
        nativePathDisposition: cleanupWarning === undefined ? 'retired' : 'retirable',
        showTouches: false,
      },
    );
  } catch (error) {
    await recorder.remove(device, descriptor.remotePath).catch(() => {});
    throw error;
  }
}

async function cleanupCompletedHarmonyArtifacts(
  recorder: HarmonyScreenRecorder,
  device: DeviceInfo,
  descriptor: HarmonyRecordingDescriptor,
  mediaUri: string,
): Promise<string | undefined> {
  const unconfirmed: string[] = [];
  if (!(await confirmedRemoval(() => recorder.remove(device, descriptor.remotePath))))
    unconfirmed.push('staging artifact');
  if (!(await confirmedRemoval(() => recorder.removeMedia(device, mediaUri))))
    unconfirmed.push('media-library artifact');
  return unconfirmed.length === 0
    ? undefined
    : `HarmonyOS recording completed, but cleanup was not confirmed for the ${unconfirmed.join(' and ')}.`;
}

async function confirmedRemoval(remove: () => Promise<boolean>): Promise<boolean> {
  try {
    return await remove();
  } catch {
    return false;
  }
}

function appendCompletionWarning(
  existing: string | undefined,
  cleanup: string | undefined,
): { warning?: string } {
  const warning = [existing, cleanup]
    .filter((value): value is string => value !== undefined)
    .join(' ');
  return warning.length === 0 ? {} : { warning };
}

async function stageHarmonyMedia(
  host: HarmonyScreenRecordingOperationHost,
  recorder: HarmonyScreenRecorder,
  device: DeviceInfo,
  descriptor: HarmonyRecordingDescriptor,
  mediaUri: string,
): Promise<boolean> {
  let previousNonzeroSize: number | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await recorder.remove(device, descriptor.remotePath).catch(() => {});
    const staged = await recorder.stageMedia(device, {
      mediaUri,
      remotePath: descriptor.remotePath,
    });
    if (staged) {
      const size = await recorder.stagedFileSize(device, descriptor.remotePath);
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
  recorder: HarmonyScreenRecorder,
  device: DeviceInfo,
  descriptor: HarmonyRecordingDescriptor,
  stopRecorder?: () => Promise<void>,
): Promise<CleanupOutcome> {
  const failures = [
    await cleanupFailure(
      stopRecorder ??
        (async () => {
          assertHarmonyRecorderCommandSucceeded(await recorder.stop(device), 'stop');
        }),
    ),
    await cleanupFailure(async () => {
      if (!(await recorder.remove(device, descriptor.remotePath))) {
        throw new Error('HarmonyOS recording staging artifact removal was not confirmed');
      }
    }),
    await cleanupFailure(
      async () => await removeHarmonyMedia(recorder, device, descriptor.fileName),
    ),
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
  recorder: HarmonyScreenRecorder,
  device: DeviceInfo,
  fileName: string,
): Promise<void> {
  const mediaUri = await recorder.findMedia(device, fileName);
  if (mediaUri && !(await recorder.removeMedia(device, mediaUri))) {
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
