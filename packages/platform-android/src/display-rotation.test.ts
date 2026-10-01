import { describe, expect, test } from 'vitest';
import { parseAndroidDisplayRotationIndex } from './display-rotation.ts';

describe('parseAndroidDisplayRotationIndex', () => {
  test('reads the rotation index dumpsys display reports', () => {
    expect(parseAndroidDisplayRotationIndex('  mCurrentOrientation=1\n  mOther=2\n')).toBe('1');
  });

  test('has no index when the key is absent', () => {
    expect(parseAndroidDisplayRotationIndex('  mOverrideDisplayInfo=DisplayInfo{}\n')).toBe(
      undefined,
    );
  });
});
