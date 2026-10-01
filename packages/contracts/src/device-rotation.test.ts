import { describe, expect, test } from 'vitest';
import {
  DEVICE_ROTATIONS,
  deviceRotationFromSurfaceIndex,
  isDeviceRotation,
  parseDeviceRotation,
} from './device-rotation.ts';

describe('parseDeviceRotation', () => {
  test('accepts the canonical orientation names', () => {
    expect(parseDeviceRotation('portrait')).toBe('portrait');
    expect(parseDeviceRotation('portrait-upside-down')).toBe('portrait-upside-down');
    expect(parseDeviceRotation('landscape-left')).toBe('landscape-left');
    expect(parseDeviceRotation('landscape-right')).toBe('landscape-right');
  });

  test('accepts the documented short aliases', () => {
    expect(parseDeviceRotation('upside-down')).toBe('portrait-upside-down');
    expect(parseDeviceRotation('left')).toBe('landscape-left');
    expect(parseDeviceRotation('right')).toBe('landscape-right');
  });

  test('is case-insensitive and trims surrounding whitespace', () => {
    expect(parseDeviceRotation('  Landscape-LEFT ')).toBe('landscape-left');
  });

  test('throws a helpful error when the orientation is missing', () => {
    expect(() => parseDeviceRotation(undefined)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('orientation requires an orientation argument'),
      }),
    );
  });

  test('throws on an unrecognized orientation and echoes the bad input', () => {
    expect(() => parseDeviceRotation('sideways')).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('Invalid rotation: sideways'),
      }),
    );
  });
});

describe('deviceRotationFromSurfaceIndex', () => {
  test('reads the Android Surface.ROTATION_* index each rotation is observed at', () => {
    // Observed on an Android 37 emulator: `orientation <rotation>` then `dumpsys display`.
    expect(deviceRotationFromSurfaceIndex(0)).toBe('portrait');
    expect(deviceRotationFromSurfaceIndex(1)).toBe('landscape-left');
    expect(deviceRotationFromSurfaceIndex(2)).toBe('portrait-upside-down');
    expect(deviceRotationFromSurfaceIndex(3)).toBe('landscape-right');
  });

  test('has no rotation for an index outside the surface table', () => {
    expect(deviceRotationFromSurfaceIndex(4)).toBeUndefined();
  });
});

describe('isDeviceRotation', () => {
  test('accepts the canonical names and rejects aliases and non-strings', () => {
    for (const rotation of DEVICE_ROTATIONS) expect(isDeviceRotation(rotation)).toBe(true);
    expect(isDeviceRotation('left')).toBe(false);
    expect(isDeviceRotation(undefined)).toBe(false);
    expect(isDeviceRotation(1)).toBe(false);
  });
});
