import type { AppleOS, DeviceKind, DeviceTarget, Platform, PlatformSelector } from './device.ts';

/**
 * The device record every surface carries. Types only: `device.ts` re-exports them, and nothing
 * imports this module at runtime, so it adds no module to any import closure.
 */
export type DeviceInfo = {
  platform: Platform;
  id: string;
  name: string;
  kind: DeviceKind;
  target?: DeviceTarget;
  // Explicit Apple OS discriminant populated at discovery for Apple devices.
  // Optional so legacy records (and non-Apple platforms) remain valid.
  appleOs?: AppleOS;
  // Presentation-only hardware model and OS version reported by discovery when the
  // platform tooling exposes them; never part of device identity or selection.
  model?: string;
  osVersion?: string;
  booted?: boolean;
  simulatorSetPath?: string;
  // Internal physical-iOS execution backend selected during discovery.
  // Public device projections strip this field.
  iosPhysicalDeviceBackend?: 'coredevice' | 'xctest';
  /**
   * Set when this device is one app of a host device rather than the host itself (ADR 0035). Its
   * id is {@link hostAppDeviceId} of the two, so every per-device lock, claim, and session check
   * treats the app as a device of its own; only {@link devicesOverlap} relates it to its host.
   */
  hostApp?: { hostDeviceId: string; bundleId: string };
};

/** A named session with an optional tenant, or an implicit workspace session without a name. */
export type WebSessionIdentity =
  | Readonly<{ name: string; namespace?: { kind: 'tenant'; id: string } }>
  | Readonly<{ kind: 'workspace'; id: string }>;

export type DeviceSelector = {
  platform?: PlatformSelector;
  target?: DeviceTarget;
  deviceName?: string;
  udid?: string;
  serial?: string;
};

export type DeviceIdentityFlag = 'udid' | 'serial';
