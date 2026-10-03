import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isAndroidEmulatorSerial,
  normalizeAndroidDeviceName,
  parseAndroidAvdList,
  parseAndroidDeviceDescription,
  parseAndroidDeviceEntries,
  parseAndroidEmulatorAvdNameOutput,
  parseAndroidFeatureListForTv,
  parseAndroidTargetFromCharacteristics,
} from './inventory-parsers.ts';

test('Android inventory identity normalizes AVD names and recognizes emulator serials', () => {
  assert.equal(normalizeAndroidDeviceName(' Pixel_9   Pro '), 'pixel 9 pro');
  assert.equal(isAndroidEmulatorSerial('emulator-5554'), true);
  assert.equal(isAndroidEmulatorSerial('R58M123ABC'), false);
});

test('Android inventory parsers preserve device, AVD-name, and TV detection semantics', () => {
  assert.deepEqual(
    parseAndroidDeviceEntries(
      'List of devices attached\nemulator-5554 device product:sdk model:Pixel_9_Pro_XL\noffline offline\n',
    ),
    [{ serial: 'emulator-5554', rawModel: 'Pixel_9_Pro_XL' }],
  );
  assert.deepEqual(parseAndroidAvdList('\nPixel_9_Pro_XL\n\nWear_OS\n'), [
    'Pixel_9_Pro_XL',
    'Wear_OS',
  ]);
  assert.equal(parseAndroidEmulatorAvdNameOutput('Pixel_9_Pro_XL\r\nOK\r\n'), 'Pixel_9_Pro_XL');
  assert.equal(parseAndroidEmulatorAvdNameOutput('\r\nOK\r\n'), undefined);
  assert.equal(parseAndroidTargetFromCharacteristics('tv,nosdcard'), 'tv');
  assert.equal(parseAndroidTargetFromCharacteristics('phone,tablet'), null);
  assert.equal(parseAndroidFeatureListForTv('feature:android.hardware.type.television'), true);
});

test('Android description parser reads the model and OS version lines and skips unset props', () => {
  assert.deepEqual(parseAndroidDeviceDescription('sdk_gphone16k_arm64\r\n17\r\n'), {
    model: 'sdk_gphone16k_arm64',
    osVersion: '17',
  });
  assert.deepEqual(parseAndroidDeviceDescription('\n16\n'), { osVersion: '16' });
  assert.deepEqual(parseAndroidDeviceDescription(''), {});
});
