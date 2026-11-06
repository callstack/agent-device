import { isHandheldAppleSimulator, type DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { runXcrun } from './tool-provider.ts';

const ACCESSIBILITY_PREPARE_TIMEOUT_MS = 2_000;

/** Enables app accessibility before launch or after XCTest teardown, without booting the device. */
export async function prepareIosSimulatorAccessibility(device: DeviceInfo): Promise<void> {
  if (!isHandheldAppleSimulator(device)) return;
  try {
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
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_simulator_accessibility_prepare_failed',
      data: { deviceId: device.id, error: normalizeError(error) },
    });
  }
}
