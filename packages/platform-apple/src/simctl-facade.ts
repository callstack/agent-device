import type { DeviceInfo } from '@agent-device/kernel/device';

import { buildSimctlArgsForDevice } from './core/simctl.ts';

export { buildSimctlArgsForDevice };

/**
 * Builds the `simctl io recordVideo` argv for one Apple simulator, naming the panel the device
 * currently lights.
 *
 * A foldable lights one panel at a time and simctl's implicit display default is the highest screen
 * ID — the dark panel — so a recording that omits `--display` captures black while exiting 0. The
 * panel decision belongs to the Apple package, which owns the display inventory.
 *
 * The inventory is imported per call, not statically: this façade keeps its eager closure at the
 * simctl argv builder, and recording is not a startup path.
 */
export async function buildAppleSimulatorRecordVideoArgs(
  device: DeviceInfo,
  outputPath: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string[]> {
  const { appleSimulatorDisplayArgvFragment, resolveAppleCaptureDisplay } =
    await import('./core/display-inventory.ts');
  const display = await resolveAppleCaptureDisplay(device, options);
  return buildSimctlArgsForDevice(device, [
    'io',
    device.id,
    'recordVideo',
    ...appleSimulatorDisplayArgvFragment(display),
    outputPath,
  ]);
}
