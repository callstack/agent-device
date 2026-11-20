import { isHandheldAppleDevice, type DeviceInfo } from '@agent-device/kernel/device';

export function isRunnerServedIos(device: DeviceInfo): boolean {
  return (
    isHandheldAppleDevice(device) &&
    (device.kind === 'simulator' || device.iosPhysicalDeviceBackend === 'xctest')
  );
}
