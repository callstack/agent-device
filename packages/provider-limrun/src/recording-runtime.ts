import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { CleanupOutcome } from '@agent-device/contracts/durable-resource';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { RecordingExportQuality } from '@agent-device/contracts/recording';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import {
  type ScreenRecordingLiveSnapshot,
  type ScreenRecordingRuntimeOperations,
  type ScreenRecordingStartInput,
  SCREEN_RECORDING_RESOURCE_KIND,
} from '@agent-device/contracts/screen-recording-runtime';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import {
  assertScreenRecordingOptionsSupported,
  createDurableResourceEnvelope,
  createScreenRecordingCompletion,
  createScreenRecordingLiveHandle,
  encodeDurableDescriptor,
} from '@agent-device/capture-kit';
import type { LimrunDeviceSession, LimrunRecordingQuality } from './device-session.ts';

/** The slice of a live Limrun device session the recorder needs. */
export type LimrunScreenRecordingSession = Pick<
  LimrunDeviceSession,
  'startRecording' | 'stopRecording'
>;

type LimrunScreenRecordingOperationHost = Readonly<{
  screenRecording: Pick<ScreenRecordingRuntimeHost, 'finalize' | 'outputs'>;
}>;

const LIMRUN_RECORDING_BACKEND = 'limrun-recorder';

type LimrunRecordingDescriptor = Readonly<{
  backend: typeof LIMRUN_RECORDING_BACKEND;
  outputPath: string;
}>;

const descriptorCodec = Object.freeze({
  resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
  version: 1,
  encode: (descriptor: LimrunRecordingDescriptor) => ({ ...descriptor }),
  decode: (body: Record<string, unknown>) =>
    body.backend === LIMRUN_RECORDING_BACKEND && typeof body.outputPath === 'string'
      ? ({
          status: 'decoded',
          descriptor: Object.freeze({
            backend: LIMRUN_RECORDING_BACKEND,
            outputPath: body.outputPath,
          }),
        } as const)
      : ({ status: 'invalid', message: 'Invalid Limrun screen-recording descriptor' } as const),
});

/**
 * Limrun's recorder takes a 5..10 quality; the two public presets land on the low end of the
 * legacy numeric band each one replaced (5..7 read as medium, 8..10 as high).
 */
const LIMRUN_QUALITY_BY_EXPORT: Readonly<Record<RecordingExportQuality, LimrunRecordingQuality>> =
  Object.freeze({ medium: 5, high: 8 });

/**
 * Screen recording on a Limrun-owned device rides the provider's server-side recorder: start and
 * stop are instance API calls, and stop downloads the finished MP4 to the requested path. The
 * capture is always the whole simulator or emulator screen, so every scope records the same frame.
 */
export function createLimrunScreenRecordingOperations(params: {
  host: LimrunScreenRecordingOperationHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  signal: AbortSignal;
  getDeviceSession(device: DeviceInfo): LimrunScreenRecordingSession | undefined;
}): ScreenRecordingRuntimeOperations {
  return Object.freeze({
    screenRecordingStart: async (input) => await startLimrunRecording(params, input),
    screenRecordingReattach: async () => ({
      status: 'unreattachable' as const,
      reason: 'transport-not-reattachable' as const,
      message: 'Limrun recordings cannot be reattached after daemon restart.',
    }),
    screenRecordingCleanup: async () => pendingLimrunCleanup(),
  } satisfies ScreenRecordingRuntimeOperations);
}

async function startLimrunRecording(
  params: Parameters<typeof createLimrunScreenRecordingOperations>[0],
  input: ScreenRecordingStartInput,
) {
  const { host, device, owner, signal } = params;
  assertScreenRecordingOptionsSupported(
    input,
    { scopes: ['app', 'device', 'system'], fps: false, exportQuality: true, hideTouches: false },
    (unsupported) => `Limrun recordings do not support ${unsupported.join(', ')}`,
  );
  const session = params.getDeviceSession(device);
  if (!session) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Limrun recording requires a live provider session for this device.',
      { deviceId: device.id },
    );
  }
  signal.throwIfAborted();
  await host.screenRecording.outputs.prepare(input.outputPath);
  let stopped = false;
  const stop = async (outPath: string) => {
    if (stopped) return;
    await session.stopRecording({ outPath });
    stopped = true;
  };
  let acquired = false;
  try {
    await session.startRecording({
      quality: LIMRUN_QUALITY_BY_EXPORT[input.exportQuality ?? 'medium'],
    });
    acquired = true;
    signal.throwIfAborted();
  } catch (error) {
    if (acquired) await discardLimrunRecording(host, stop, input.outputPath).catch(() => {});
    signal.throwIfAborted();
    throw error;
  }
  const handle = createScreenRecordingLiveHandle(snapshot(input), {
    finish: async (current) => {
      await stop(current.outPath);
      const finalization = await host.screenRecording.finalize.complete({
        outputPath: current.outPath,
        showTouches: false,
        gestureEvents: current.gestureEvents,
        ...(current.exportQuality === undefined ? {} : { exportQuality: current.exportQuality }),
        targetLabel: 'Limrun recording',
      });
      return createScreenRecordingCompletion(current, finalization, {
        // The provider acknowledged the stop and served the file; nothing else writes it.
        stopObservation: { recorder: 'confirmed' },
        showTouches: false,
      });
    },
    forceCleanup: async (current) => {
      try {
        await discardLimrunRecording(host, stop, current.outPath);
        return { status: 'cleaned' } as const;
      } catch (error) {
        return {
          status: 'cleanup-pending',
          reason: 'transport-failed',
          message: error instanceof Error ? error.message : 'Limrun recording cleanup failed',
        } as const;
      }
    },
  });
  return Object.freeze({
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createDurableResourceEnvelope({
      resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
      sessionId: input.sessionId,
      device: deviceIdentity(device),
      owner,
      fence: input.fence,
      lifecycle: 'open',
      descriptor: encodeDurableDescriptor(descriptorCodec, {
        backend: LIMRUN_RECORDING_BACKEND,
        outputPath: input.outputPath,
      }),
    }),
  });
}

/**
 * Limrun only stops a recording by serving it, so a discarded recording is stopped into the
 * output path and that file is removed again.
 */
async function discardLimrunRecording(
  host: LimrunScreenRecordingOperationHost,
  stop: (outPath: string) => Promise<void>,
  outputPath: string,
): Promise<void> {
  await stop(outputPath);
  await host.screenRecording.outputs.remove(outputPath);
}

function snapshot(input: ScreenRecordingStartInput): ScreenRecordingLiveSnapshot {
  return Object.freeze({
    backend: LIMRUN_RECORDING_BACKEND,
    outPath: input.outputPath,
    ...(input.clientOutputPath === undefined ? {} : { clientOutPath: input.clientOutputPath }),
    startedAt: Date.now(),
    scope: input.scope,
    showTouches: false,
    recordOnlySession: input.recordOnlySession,
    ...(input.activeSessionApp === undefined ? {} : { activeSessionApp: input.activeSessionApp }),
    ...(input.exportQuality === undefined ? {} : { exportQuality: input.exportQuality }),
    gestureEvents: [],
  });
}

function pendingLimrunCleanup(): CleanupOutcome {
  return {
    status: 'cleanup-pending',
    reason: 'manual-recovery-required',
    message:
      'Limrun recordings cannot be cleaned after daemon restart; the instance disposes them when it terminates.',
  };
}
