import type { AudioProbeSource } from '../audio-probe-result.ts';
import { isHostSystemAudioProbeDevice } from '../kernel/audio-probe-support.ts';
import type { DeviceInfo } from '../kernel/device.ts';
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
