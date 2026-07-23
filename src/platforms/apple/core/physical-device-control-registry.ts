import type { DeviceInfo } from '../../../kernel/device.ts';

export type IosPhysicalDeviceBackend = 'coredevice' | 'xctest';

export type IosPhysicalDeviceBackendRegistry = {
  backendForDevice(device: Pick<DeviceInfo, 'id'>): IosPhysicalDeviceBackend;
  recordBackend(deviceId: string, backend: IosPhysicalDeviceBackend): void;
  clear(): void;
};

export function createIosPhysicalDeviceBackendRegistry(
  defaultBackend: IosPhysicalDeviceBackend = 'coredevice',
): IosPhysicalDeviceBackendRegistry {
  const backendsByDeviceId = new Map<string, IosPhysicalDeviceBackend>();
  return {
    backendForDevice: (device) => backendsByDeviceId.get(device.id) ?? defaultBackend,
    recordBackend: (deviceId, backend) => {
      backendsByDeviceId.set(deviceId, backend);
    },
    clear: () => {
      backendsByDeviceId.clear();
    },
  };
}

export const iosPhysicalDeviceBackendRegistry = createIosPhysicalDeviceBackendRegistry();

export function recordDiscoveredIosPhysicalDeviceBackends(
  coreDeviceDevices: readonly Pick<DeviceInfo, 'id'>[],
  xctraceDevices: readonly Pick<DeviceInfo, 'id'>[],
): void {
  const coreDeviceIds = new Set(coreDeviceDevices.map((device) => device.id));
  for (const device of coreDeviceDevices) {
    iosPhysicalDeviceBackendRegistry.recordBackend(device.id, 'coredevice');
  }
  for (const device of xctraceDevices) {
    if (!coreDeviceIds.has(device.id)) {
      iosPhysicalDeviceBackendRegistry.recordBackend(device.id, 'xctest');
    }
  }
}

export function iosPhysicalDeviceBackendForDevice(
  device: Pick<DeviceInfo, 'id'>,
): IosPhysicalDeviceBackend {
  return iosPhysicalDeviceBackendRegistry.backendForDevice(device);
}
