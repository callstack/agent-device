import { isIosFamily, type DeviceInfo } from '../../../../kernel/device.ts';
import type { HostAudioProbeBackend } from '../../../audio-probe-backend.ts';
import { startMacOsAudioProbeProcess } from './helper.ts';

export const macOsScreenCaptureKitAudioProbeBackend = {
  platform: 'host-system-audio',
  source: 'system-audio',
  backend: 'macos-screencapturekit',
  sourceCount: 1,
  start: startMacOsAudioProbeProcess,
  notes: hostSystemAudioProbeNotes,
} as const satisfies HostAudioProbeBackend;

function hostSystemAudioProbeNotes(device: DeviceInfo): string[] {
  const target = isIosFamily(device)
    ? 'iOS simulator'
    : device.platform === 'android'
      ? 'Android emulator'
      : 'macOS session';
  return [
    `Audio probe samples host system audio through ScreenCaptureKit for this ${target}; it is not app-instrumented audio.`,
    'Screen Recording permission is required for host system audio capture.',
    'Other audible host apps can contribute to the measured buckets.',
  ];
}
