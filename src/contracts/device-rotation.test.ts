import { describe, expect, test } from 'vitest';
import { parseDeviceRotation } from './device-rotation.ts';

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
        message: expect.stringContaining('rotate requires an orientation argument'),
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
