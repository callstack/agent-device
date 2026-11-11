import { PLATFORM_SELECTORS, type PlatformSelector } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';

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

const DEVICE_PIN_SELECTOR_KEYS = ['platform', 'device', 'udid', 'serial'] as const;

export function parseDevicePinSelector(value: unknown, pinSource: string): DevicePinSelector {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    invalidDevicePin(`devicePin in ${pinSource} must be a non-empty selector object.`, pinSource);
  }
  const selector: DevicePinSelector = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      !DEVICE_PIN_SELECTOR_KEYS.includes(key as keyof DevicePinSelector) ||
      typeof raw !== 'string' ||
      !raw.trim() ||
      (key === 'platform' && !PLATFORM_SELECTORS.includes(raw as PlatformSelector))
    ) {
      invalidDevicePin(`Invalid devicePin.${key} in ${pinSource}.`, pinSource);
    }
    Object.assign(selector, { [key]: raw });
  }
  return selector;
}

export function readDevicePin(value: unknown): DevicePin | undefined {
  if (value === undefined) return undefined;
  const context = 'daemon request metadata';
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'selector' && key !== 'source') ||
    !isRecord(value.source)
  ) {
    invalidDevicePin('devicePin must contain selector and source objects.', context);
  }
  const { kind, path } = value.source;
  if (
    (kind !== 'user' && kind !== 'project' && kind !== 'explicit') ||
    typeof path !== 'string' ||
    !path.trim() ||
    Object.keys(value.source).some((key) => key !== 'kind' && key !== 'path')
  ) {
    invalidDevicePin('devicePin.source must contain a config kind and non-empty path.', context);
  }
  const pinSource = `${kind === 'project' ? 'project ' : ''}config file ${path}`;
  return { selector: parseDevicePinSelector(value.selector, pinSource), source: { kind, path } };
}

function invalidDevicePin(message: string, pinSource: string): never {
  throw new AppError('INVALID_ARGS', message, { reason: 'invalid_device_pin', pinSource });
}
