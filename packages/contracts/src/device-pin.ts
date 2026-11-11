import {
  matchesDeviceNameSelector,
  matchesDeviceSelector,
  platformSelectorsConflict,
  type DeviceInfo,
  type PlatformSelector,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

export const DEVICE_PIN_SELECTOR_KEYS = ['platform', 'device', 'udid', 'serial'] as const;

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

type PinConflict = {
  key: keyof DevicePinSelector;
  pinned: string;
  requested: string;
  step?: number;
};

export function devicePinSourceLabel(source: DevicePin['source']): string {
  return `${source.kind === 'project' ? 'project ' : ''}config file ${source.path}`;
}

export function assertRequestHonorsDevicePin(
  pin: DevicePin,
  request: {
    flags?: Readonly<Record<string, unknown>> & {
      batchSteps?: ReadonlyArray<{ flags?: Readonly<Record<string, unknown>> }>;
    };
  },
): void {
  const conflicts: PinConflict[] = [];
  const collect = (flags: Readonly<Record<string, unknown>> | undefined, step?: number) => {
    for (const key of DEVICE_PIN_SELECTOR_KEYS) {
      const pinned = pin.selector[key];
      const requested = flags?.[key];
      if (pinned === undefined || typeof requested !== 'string') continue;
      const matches =
        key === 'device'
          ? matchesDeviceNameSelector({ name: pinned }, requested)
          : key === 'platform'
            ? !platformSelectorsConflict(requested as PlatformSelector, pin.selector.platform)
            : requested === pinned;
      if (!matches) conflicts.push({ key, pinned, requested, ...(step ? { step } : {}) });
    }
  };
  collect(request.flags);
  request.flags?.batchSteps?.forEach((step, index) => collect(step.flags, index + 1));
  if (conflicts.length) throwPinConflict(pin, conflicts);
}

export function assertDeviceHonorsPin(pin: DevicePin, device: DeviceInfo): void {
  if (
    matchesDeviceSelector(
      device,
      { ...pin.selector, deviceName: pin.selector.device },
      { includeExplicitSelectors: true },
    )
  )
    return;
  throwPinConflict(pin, [], { id: device.id, name: device.name });
}

function throwPinConflict(
  pin: DevicePin,
  conflicts: PinConflict[],
  device?: { id: string; name: string },
): never {
  const first = conflicts[0];
  const where = first?.step === undefined ? '' : `Batch step ${first.step}: `;
  const requested = first
    ? `${first.key} ${JSON.stringify(first.requested)}`
    : `Device ${JSON.stringify(device?.name)} (${device?.id})`;
  const source = devicePinSourceLabel(pin.source);
  throw new AppError(
    'INVALID_ARGS',
    `${where}${requested} conflicts with the device pin from ${source}.`,
    {
      reason: 'device_pin_conflict',
      pin: { ...pin.selector },
      pinSource: source,
      conflicts,
      ...(device ? { device } : {}),
      hint: `Use a device matching ${JSON.stringify(pin.selector)}, or edit or remove devicePin in ${pin.source.path}.`,
    },
  );
}
