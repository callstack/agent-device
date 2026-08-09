import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';

export const APPLE_XCTEST_LOGS_HINT =
  'This command requires a CoreDevice-backed physical iOS device. The selected XCTest backend supports open, close, interactions, snapshots, and screenshots.';

export function backendForAppleDevice(
  device: DeviceInfo,
): 'ios-simulator' | 'ios-device' | 'macos' {
  if (isMacOs(device)) return 'macos';
  return device.kind === 'device' ? 'ios-device' : 'ios-simulator';
}
