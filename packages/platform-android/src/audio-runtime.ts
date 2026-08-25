import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform';
import { isHostSystemAudioProbeDevice } from '@agent-device/contracts/audio-probe-support';

/**
 * The Android cells of the retired `audio` bucket, stated exactly: the darwin host's
 * ScreenCaptureKit sampler serves Android emulators, so the cell is available only for an
 * emulator on a macOS host — every other kind or host is a stated refusal.
 */
export function androidAudioProbeCaptureFact(device: DeviceInfo): RuntimeOperationFact {
  if (isHostSystemAudioProbeDevice(device)) return Object.freeze({ available: true });
  if (device.kind === 'emulator') {
    return Object.freeze({
      available: false,
      reason: 'unsupported-device-backend' as const,
      hint: 'audio probe capture requires a macOS host.',
    });
  }
  return Object.freeze({
    available: false,
    reason: 'unsupported-device-kind' as const,
    hint: 'audio probe capture is supported for Android emulators on macOS hosts.',
  });
}
