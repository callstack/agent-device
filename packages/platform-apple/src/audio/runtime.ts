import { isIosFamily, isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import type {
  AudioProbeReattachInput,
  AudioProbeStartInput,
  PlatformRuntimeHost,
  RuntimeOperationFact,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import { isHostSystemAudioProbeDevice } from '@agent-device/contracts/audio-probe-support';
import {
  createHostAudioProbeRecoveryOperations,
  startHostAudioProbe,
} from '@agent-device/capture-kit';

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

export function createAppleAudioProbeOperations(params: {
  host: PlatformRuntimeHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
}): Readonly<{
  audioProbeStart(input: AudioProbeStartInput): ReturnType<typeof startHostAudioProbe>;
  audioProbeReattach: ReturnType<
    typeof createHostAudioProbeRecoveryOperations
  >['audioProbeReattach'];
  audioProbeCleanup: ReturnType<typeof createHostAudioProbeRecoveryOperations>['audioProbeCleanup'];
}> {
  const { host, device, owner } = params;
  const recovery = createHostAudioProbeRecoveryOperations({ host: host.audioProbe.hostCapture });
  return Object.freeze({
    audioProbeStart: async (input: AudioProbeStartInput) =>
      await startHostAudioProbe({ host: host.audioProbe.hostCapture, device, owner, input }),
    audioProbeReattach: async (input: AudioProbeReattachInput) =>
      await recovery.audioProbeReattach(input),
    audioProbeCleanup: async (input: AudioProbeReattachInput) =>
      await recovery.audioProbeCleanup(input),
  });
}
