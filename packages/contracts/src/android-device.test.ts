import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isAndroidEmulatorSerial, normalizeAndroidDeviceName } from './android-device.ts';

test('Android device identity normalizes AVD names and recognizes running emulator serials', () => {
  assert.equal(normalizeAndroidDeviceName(' Pixel_9   Pro '), 'pixel 9 pro');
  assert.equal(isAndroidEmulatorSerial('emulator-5554'), true);
  assert.equal(isAndroidEmulatorSerial('R58M123ABC'), false);
});
