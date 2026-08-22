import type { AudioProbeSource } from '@agent-device/contracts/platform';
import { isHostSystemAudioProbeDevice } from '@agent-device/contracts/audio-probe-support';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ExecBackgroundResult } from '../utils/exec.ts';

export type HostAudioProbeStartOptions = {
  durationMs: number;
  bucketMs: number;
  statusPath: string;
};

export type HostAudioProbeBackend = {
  platform: 'host-system-audio';
  source: AudioProbeSource;
  backend: string;
  sourceCount: number;
  start(options: HostAudioProbeStartOptions): Promise<ExecBackgroundResult>;
  notes(device: DeviceInfo): string[];
};

export async function resolveHostAudioProbeBackend(
  device: DeviceInfo,
): Promise<HostAudioProbeBackend | undefined> {
  if (!isHostSystemAudioProbeDevice(device)) return undefined;
  const { macOsScreenCaptureKitAudioProbeBackend } =
    await import('./apple/os/macos/audio-probe.ts');
  return macOsScreenCaptureKitAudioProbeBackend;
}
