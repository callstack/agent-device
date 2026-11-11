import {
  DEVICE_PIN_SELECTOR_KEYS,
  devicePinSourceLabel,
  type DevicePin,
  type DevicePinSelector,
} from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { getOptionSpec, parseOptionValueFromSource } from './option-schema.ts';

export function parseDevicePin(value: unknown, source: DevicePin['source']): DevicePin {
  const label = devicePinSourceLabel(source);
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new AppError(
      'INVALID_ARGS',
      `devicePin in ${label} must be a non-empty selector object.`,
      {
        reason: 'invalid_device_pin',
        pinSource: label,
      },
    );
  }
  const selector: DevicePinSelector = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      !DEVICE_PIN_SELECTOR_KEYS.includes(key as keyof DevicePinSelector) ||
      typeof raw !== 'string' ||
      !raw.trim()
    ) {
      throw new AppError(
        'INVALID_ARGS',
        `Invalid devicePin.${key} in ${label}. Use platform, device, udid, or serial with non-empty string values.`,
        {
          reason: 'invalid_device_pin',
          pinSource: label,
        },
      );
    }
    const spec = getOptionSpec(key as keyof DevicePinSelector)!;
    Object.assign(selector, {
      [key]: parseOptionValueFromSource(spec, raw, label, `devicePin.${key}`),
    });
  }
  return { selector, source };
}
