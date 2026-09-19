import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { RecordingExportQuality } from '@agent-device/contracts/recording';
import type {
  ScreenRecordingRuntimeOperations,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/screen-recording-runtime';
import {
  type ScreenRecordingTransportHost,
  startTransportScreenRecording,
  transportRecordingCleanupPending,
  transportRecordingUnreattachable,
} from '@agent-device/capture-kit/screen-recording-transport';
import type { LimrunDeviceSession, LimrunRecordingQuality } from './device-session.ts';

/** The slice of a live Limrun device session the recorder needs. */
export type LimrunScreenRecordingSession = Pick<
  LimrunDeviceSession,
  'startRecording' | 'stopRecording' | 'downloadRecording'
>;

const LIMRUN_RECORDING_BACKEND = 'limrun-recorder';

/**
 * Limrun's recorder takes a 5..10 quality; the two public presets land on the low end of the
 * legacy numeric band each one replaced (5..7 read as medium, 8..10 as high).
 */
const LIMRUN_QUALITY_BY_EXPORT: Readonly<Record<RecordingExportQuality, LimrunRecordingQuality>> =
  Object.freeze({ medium: 5, high: 8 });

/**
 * Screen recording on a Limrun-owned device rides the provider's server-side recorder. Start and
 * stop are instance API calls; stop answers with the URL the finished MP4 is served from, and the
 * download to the output path is a separate, bounded, retriable step. The capture is always the
 * whole simulator or emulator screen, so every scope records the same frame.
 */
export function createLimrunScreenRecordingOperations(params: {
  host: ScreenRecordingTransportHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  signal: AbortSignal;
  getDeviceSession(device: DeviceInfo): LimrunScreenRecordingSession | undefined;
}): ScreenRecordingRuntimeOperations {
  return Object.freeze({
    screenRecordingStart: async (input) => await startLimrunRecording(params, input),
    screenRecordingReattach: async () =>
      transportRecordingUnreattachable(
        'Limrun recordings cannot be reattached after daemon restart.',
      ),
    screenRecordingCleanup: async () =>
      transportRecordingCleanupPending(
        'Limrun recordings cannot be cleaned after daemon restart; the instance disposes them when it terminates.',
      ),
  } satisfies ScreenRecordingRuntimeOperations);
}

async function startLimrunRecording(
  params: Parameters<typeof createLimrunScreenRecordingOperations>[0],
  input: ScreenRecordingStartInput,
) {
  const session = params.getDeviceSession(params.device);
  if (!session) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Limrun recording requires a live provider session for this device.',
      { deviceId: params.device.id },
    );
  }
  return await startTransportScreenRecording({
    host: params.host,
    device: params.device,
    owner: params.owner,
    input,
    signal: params.signal,
    transport: {
      backend: LIMRUN_RECORDING_BACKEND,
      targetLabel: 'Limrun recording',
      start: async () => {
        await session.startRecording({
          quality: LIMRUN_QUALITY_BY_EXPORT[input.exportQuality ?? 'medium'],
        });
      },
      stop: async () => (await session.stopRecording()).downloadUrl,
      collect: async (downloadUrl, outputPath) => {
        await session.downloadRecording({ downloadUrl, outPath: outputPath });
      },
    },
    support: {
      scopes: ['app', 'device', 'system'],
      fps: false,
      exportQuality: true,
      hideTouches: false,
    },
    unsupported: (unsupported) => `Limrun recordings do not support ${unsupported.join(', ')}`,
  });
}
