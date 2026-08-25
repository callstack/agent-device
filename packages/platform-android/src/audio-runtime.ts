import type { DeviceInfo } from '@agent-device/kernel/device';
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

export function createAndroidAudioProbeOperations(params: {
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
