import { AppError } from '../kernel/errors.ts';

export const DEVICE_ROTATIONS = [
  'portrait',
  'portrait-upside-down',
  'landscape-left',
  'landscape-right',
] as const;
export type DeviceRotation = (typeof DEVICE_ROTATIONS)[number];

export function parseDeviceRotation(input: string | undefined): DeviceRotation {
  if (input === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      'orientation requires an orientation argument. Use portrait|portrait-upside-down|landscape-left|landscape-right.',
    );
  }
  const normalized = input?.trim().toLowerCase();
  switch (normalized) {
    case 'portrait':
      return 'portrait';
    case 'portrait-upside-down':
    case 'upside-down':
      return 'portrait-upside-down';
    case 'landscape-left':
    case 'left':
      return 'landscape-left';
    case 'landscape-right':
    case 'right':
      return 'landscape-right';
    default:
      throw new AppError(
        'INVALID_ARGS',
        `Invalid rotation: ${input}. Use portrait|portrait-upside-down|landscape-left|landscape-right.`,
      );
  }
}
