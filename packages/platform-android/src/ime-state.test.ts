import { expect, test } from 'vitest';
import { ANDROID_EMULATOR } from '@agent-device/test-kit';
import {
  inspectAndroidSessionTeardownResources,
  isAndroidTestImeActive,
  resetAndroidTestImeActivationCacheForTests,
  setAndroidTestImeActiveForTests,
} from './ime-state.ts';

test('teardown inspection reads owned IME state without restoring or clearing it', () => {
  resetAndroidTestImeActivationCacheForTests();
  try {
    setAndroidTestImeActiveForTests(ANDROID_EMULATOR, true);
    expect(inspectAndroidSessionTeardownResources(ANDROID_EMULATOR)).toEqual(['android-test-ime']);
    expect(isAndroidTestImeActive(ANDROID_EMULATOR)).toBe(true);
    expect(
      inspectAndroidSessionTeardownResources({ ...ANDROID_EMULATOR, id: 'emulator-other' }),
    ).toEqual([]);
  } finally {
    resetAndroidTestImeActivationCacheForTests();
  }
});
