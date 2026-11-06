import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function resolveWebScreenRecordingTransport(
  device: DeviceInfo,
): ReturnType<ScreenRecordingRuntimeHost['web']['resolve']> {
  if (device.platform !== 'web') return undefined;
  const { resolveRequestScopedWebProvider } = await import('@agent-device/platform-web');
  const provider = await resolveRequestScopedWebProvider();
  if (!provider?.startRecording || !provider.stopRecording) return undefined;
  return Object.freeze({
    start: async (outputPath: string) => await provider.startRecording!(outputPath),
    stop: async () => await provider.stopRecording!(),
  });
}
