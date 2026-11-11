import type { PlatformSelector } from '@agent-device/kernel/device';

export type DevicePinSelector = {
  platform?: PlatformSelector;
  device?: string;
  udid?: string;
  serial?: string;
};

export type DevicePin = {
  selector: DevicePinSelector;
  source: { kind: 'user' | 'project' | 'explicit'; path: string };
};
