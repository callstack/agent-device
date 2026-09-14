import { describe, expect, test } from 'vitest';
import {
  NATIVE_PATH_DISPOSITION_VALUES,
  isNativePathDisposition,
} from './recording-native-path.ts';

describe('recording native-path disposition', () => {
  test('orders the three states a retained native artifact can be in', () => {
    expect(NATIVE_PATH_DISPOSITION_VALUES).toEqual(['pending', 'retirable', 'retired']);
  });

  test('guards recognize a disposition and reject anything else', () => {
    expect(isNativePathDisposition('pending')).toBe(true);
    expect(isNativePathDisposition('retired')).toBe(true);
    expect(isNativePathDisposition('deleted')).toBe(false);
    expect(isNativePathDisposition(undefined)).toBe(false);
  });
});
