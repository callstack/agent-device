import type { AppleOS, DeviceInfo, DeviceKind, DeviceTarget, Platform } from './device.ts';

export type DeviceShape = Readonly<{
  family: Platform;
  appleOs?: AppleOS;
  kind: DeviceKind;
  target?: DeviceTarget;
  iosPhysicalDeviceBackend?: DeviceInfo['iosPhysicalDeviceBackend'];
}>;

export type DeviceIdentity = DeviceShape & Readonly<{ id: string }>;

type DeviceIdentitySource = Pick<
  DeviceInfo,
  'platform' | 'appleOs' | 'id' | 'kind' | 'target' | 'iosPhysicalDeviceBackend'
>;

/** Canonical ownership-qualified device shape, excluding presentation and observation fields. */
export function deviceShape(device: DeviceIdentitySource): DeviceShape {
  return Object.freeze({
    family: device.platform,
    ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
    kind: device.kind,
    ...(device.target === undefined ? {} : { target: device.target }),
    ...(device.iosPhysicalDeviceBackend === undefined
      ? {}
      : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
  });
}

/** Canonical identity shared by runtime binding, facts, and durable-resource ownership. */
export function deviceIdentity(device: DeviceIdentitySource): DeviceIdentity {
  return Object.freeze({ id: device.id, ...deviceShape(device) });
}

export function deviceIdentityKey(identity: DeviceIdentity): string {
  return JSON.stringify([identity.id, ...deviceShapeParts(identity)]);
}

export function sameDeviceIdentity(left: DeviceIdentity, right: DeviceIdentity): boolean {
  return deviceIdentityKey(left) === deviceIdentityKey(right);
}

export function sameDeviceShape(left: DeviceShape, right: DeviceShape): boolean {
  return JSON.stringify(deviceShapeParts(left)) === JSON.stringify(deviceShapeParts(right));
}

function deviceShapeParts(shape: DeviceShape): readonly unknown[] {
  return [
    shape.family,
    shape.appleOs ?? null,
    shape.kind,
    shape.target ?? null,
    shape.iosPhysicalDeviceBackend ?? null,
  ];
}
