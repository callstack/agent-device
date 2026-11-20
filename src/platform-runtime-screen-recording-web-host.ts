import type { WebPlatformSelection } from '@agent-device/contracts/platform-plugin';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function resolveWebScreenRecordingTransport(
  device: DeviceInfo,
  web?: WebPlatformSelection,
): ReturnType<ScreenRecordingRuntimeHost['web']['resolve']> {
  if (device.platform !== 'web') return undefined;
  const provider = await web?.get().operations.resolveRequestProvider();
  if (!provider?.startRecording || !provider.stopRecording) return undefined;
  return Object.freeze({
    start: async (outputPath: string) => await provider.startRecording!(outputPath),
    stop: async () => await provider.stopRecording!(),
  });
}
