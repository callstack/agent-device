import { isHandheldAppleSimulator, type DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { runXcrun } from './tool-provider.ts';

const ACCESSIBILITY_PREPARE_TIMEOUT_MS = 2_000;

/**
 * Turns simulator app accessibility on, without booting the device. XCTest teardown turns it off,
 * and apps launched while it is off expose an empty accessibility tree. Rejects on failure.
 */
export async function enableIosSimulatorAppAccessibility(device: DeviceInfo): Promise<void> {
  if (!isHandheldAppleSimulator(device)) return;
  await runXcrun(
    buildSimctlArgsForDevice(device, [
      'spawn',
      device.id,
      'defaults',
      'write',
      'com.apple.Accessibility',
      'ApplicationAccessibilityEnabled',
      '-bool',
      'YES',
    ]),
    { timeoutMs: ACCESSIBILITY_PREPARE_TIMEOUT_MS },
  );
}

/** Before a launch: a failure only warns, so it never blocks a launch that worked before. */
export async function prepareIosSimulatorAccessibility(device: DeviceInfo): Promise<void> {
  try {
    await enableIosSimulatorAppAccessibility(device);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_simulator_accessibility_prepare_failed',
      data: { deviceId: device.id, error: normalizeError(error) },
    });
  }
}
