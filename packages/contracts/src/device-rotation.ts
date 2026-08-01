import { AppError } from '@agent-device/kernel/errors';

export const DEVICE_ROTATIONS = [
  'portrait',
  'portrait-upside-down',
  'landscape-left',
  'landscape-right',
] as const;
export type DeviceRotation = (typeof DEVICE_ROTATIONS)[number];

/**
 * Android `Surface.ROTATION_*` index per rotation, which is also the value the `user_rotation`
 * system setting takes and, multiplied by 90, the `z` degrees the WebDriver `/rotation` endpoint
 * takes. One table so the adb path and the cloud WebDriver path cannot drift apart.
 */
export const DEVICE_ROTATION_SURFACE_INDEX = {
  portrait: 0,
  'landscape-left': 1,
  'portrait-upside-down': 2,
  'landscape-right': 3,
} as const satisfies Record<DeviceRotation, 0 | 1 | 2 | 3>;

export function deviceRotationSurfaceDegrees(rotation: DeviceRotation): 0 | 90 | 180 | 270 {
  return (DEVICE_ROTATION_SURFACE_INDEX[rotation] * 90) as 0 | 90 | 180 | 270;
}

/**
 * Collapses the four-way rotation onto the two values the WebDriver `/orientation` endpoint accepts.
 * Lossy by nature: both landscape rotations report `LANDSCAPE`, both portraits `PORTRAIT`.
 */
export function deviceRotationOrientation(rotation: DeviceRotation): 'PORTRAIT' | 'LANDSCAPE' {
  return DEVICE_ROTATION_SURFACE_INDEX[rotation] % 2 === 0 ? 'PORTRAIT' : 'LANDSCAPE';
}

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
