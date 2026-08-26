import { isIosFamily, isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { isHostSystemAudioProbeDevice } from '@agent-device/contracts/audio-probe-support';

/**
 * The apple cells of the retired `audio` bucket, stated exactly: the ScreenCaptureKit sampler
 * needs a darwin host and serves macOS sessions and iOS-family simulators. The legacy bucket's
 * `device: true` over-claimed — physical iOS devices were always refused by the support closure —
 * so the physical cell is a stated refusal here, not an inherited one.
 */
export function appleAudioProbeCaptureFact(device: DeviceInfo): RuntimeOperationFact {
  if (isHostSystemAudioProbeDevice(device)) return Object.freeze({ available: true });
  if (isMacOs(device) || (isIosFamily(device) && device.kind === 'simulator')) {
    return Object.freeze({
      available: false,
      reason: 'unsupported-device-backend' as const,
      hint: 'audio probe capture requires a macOS host.',
    });
  }
  return Object.freeze({
    available: false,
    reason: 'unsupported-device-kind' as const,
    hint: 'audio is supported for macOS sessions and iOS simulators on macOS hosts; physical iOS devices expose no host audio tap.',
  });
}
