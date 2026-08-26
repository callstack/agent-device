import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';

export async function validateAppleSimulatorRecording(
  device: DeviceInfo,
  input: ScreenRecordingStartInput,
  isRunnerBundleId: (bundleId: string) => Promise<boolean>,
): Promise<void> {
  if (device.kind !== 'simulator' || input.scope !== 'app') return;
  const bundleId = input.activeSessionApp?.bundleId;
  if (!bundleId) {
    throw new TypeError(
      'App-scoped recording requires an active app session; open the app under test before recording.',
    );
  }
  if (await isRunnerBundleId(bundleId)) {
    throw new TypeError(
      'App-scoped recording requires a real application session; open the app under test before recording.',
    );
  }
}
