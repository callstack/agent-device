import type { DeviceInfo } from '@agent-device/kernel/device';
import { runSimctlForDevice } from '../core/simctl-execution.ts';

/** The Darwin notification the Simulator app's Device > Shake menu posts. */
const SIMULATOR_SHAKE_NOTIFICATION = 'com.apple.UIKit.SimulatorShake';

const SIMULATOR_SHAKE_TIMEOUT_MS = 10_000;

/**
 * Posts the shake notification inside one iOS simulator. `notifyutil` answers for the post, not
 * for any app handling it, so a non-zero exit is the only failure.
 */
export async function shakeIosSimulator(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<void> {
  await runSimctlForDevice(
    device,
    ['spawn', device.id, 'notifyutil', '-p', SIMULATOR_SHAKE_NOTIFICATION],
    { signal, timeoutMs: SIMULATOR_SHAKE_TIMEOUT_MS },
  );
}
