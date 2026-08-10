import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function resolveWebScreenRecordingTransport(
  device: DeviceInfo,
): ReturnType<ScreenRecordingRuntimeHost['web']['resolve']> {
  if (device.platform !== 'web') return undefined;
  const { hasScopedWebProvider, resolveWebProvider } = await import('./platforms/web/provider.ts');
  if (!hasScopedWebProvider()) return undefined;
  const provider = resolveWebProvider();
  if (!provider.startRecording || !provider.stopRecording) return undefined;
  return Object.freeze({
    start: async (outputPath: string) => await provider.startRecording!(outputPath),
    stop: async () => await provider.stopRecording!(),
  });
}
