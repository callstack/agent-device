import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceSelectionResult } from '@agent-device/device-selection/device-selection-resolver';

/**
 * Wraps a mocked `resolveTargetDevice` so a mocked `resolveTargetDeviceSelection`
 * stays consistent with it: tests configure one device fake and both dispatch
 * entry points agree on the chosen device.
 */
export function selectionFromResolveTargetDevice(
  resolveTargetDevice: (...args: unknown[]) => unknown,
): (...args: unknown[]) => Promise<DeviceSelectionResult> {
  return async (...args: unknown[]) => ({
    device: (await resolveTargetDevice(...args)) as DeviceInfo,
    reason: 'explicit-selector',
    source: 'local',
    candidateCount: 1,
    bootOccurred: false,
  });
}
