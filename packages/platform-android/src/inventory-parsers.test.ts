import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isAndroidEmulatorSerial,
  normalizeAndroidDeviceName,
  parseAndroidAvdList,
  parseAndroidDeviceEntries,
  parseAndroidDeviceProps,
  parseAndroidEmulatorAvdNameOutput,
  androidFeatureListDeclares,
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
  const features =
    'feature:android.hardware.bluetooth_le\r\nfeature:android.hardware.type.television=1\n';
  assert.equal(androidFeatureListDeclares(features, 'android.hardware.type.television'), true);
  assert.equal(androidFeatureListDeclares(features, 'android.hardware.bluetooth'), false);
  assert.equal(
    androidFeatureListDeclares('feature:Android.Software.LEANBACK', 'android.software.leanback'),
    true,
  );
});

test('Android AVD list parser keeps AVD names and drops emulator log lines', () => {
  assert.deepEqual(
    parseAndroidAvdList(
      'INFO    | Storing crashdata in: /tmp/user/emu-crash-34.2.16.db, detection is enabled for process: 98765\r\n' +
        'Pixel_9_Pro_XL\r\nwear-os.36\r\nWARNING | unrelated log line\r\n',
    ),
    ['Pixel_9_Pro_XL', 'wear-os.36'],
  );
});

test('Android props parser reads one line per property in order and skips unset props', () => {
  assert.deepEqual(
    parseAndroidDeviceProps('1\r\nPixel_9\r\n\r\nsdk_gphone16k_arm64\r\n17\r\nemulator\r\n'),
    {
      'sys.boot_completed': '1',
      'ro.boot.qemu.avd_name': 'Pixel_9',
      'ro.product.model': 'sdk_gphone16k_arm64',
      'ro.build.version.release': '17',
      'ro.build.characteristics': 'emulator',
    },
  );
  assert.deepEqual(parseAndroidDeviceProps('\n\n\n\n16\n'), { 'ro.build.version.release': '16' });
  assert.deepEqual(parseAndroidDeviceProps(''), {});
});
