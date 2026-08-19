import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from './errors.ts';
import { resolveDevice, type DeviceInfo } from './device.ts';

// `--udid` is Apple, `--serial` is Android/HarmonyOS. Pairing one with the other platform used to
// reach resolution and answer about the WRONG platform ("No Apple device with UDID emulator-5580"
// for an explicitly --platform android request), which reads as a missing device rather than a
// mistyped flag.

const ANDROID: DeviceInfo = {
  platform: 'android',
  target: 'mobile',
  id: 'emulator-5580',
  name: 'Pixel 7',
  kind: 'emulator',
  booted: true,
};

const APPLE: DeviceInfo = {
  platform: 'apple',
  target: 'mobile',
  id: 'SIM-001',
  name: 'iPhone 16',
  kind: 'simulator',
  booted: true,
};

test('--udid with an Android platform is rejected as a flag mistake, naming --serial', async () => {
  const error = await resolveError([ANDROID], { platform: 'android', udid: 'emulator-5580' });
  assert.equal(error.code, 'INVALID_ARGS');
  assert.match(error.message, /--udid selects Apple devices/);
  assert.match(
    String(error.details?.hint ?? ''),
    /Use --serial emulator-5580 for android devices\./,
  );
});

test('--serial with an Apple platform is rejected as a flag mistake, naming --udid', async () => {
  const error = await resolveError([APPLE], { platform: 'ios', serial: 'SIM-001' });
  assert.equal(error.code, 'INVALID_ARGS');
  assert.match(error.message, /--serial selects Android and HarmonyOS devices/);
  assert.match(String(error.details?.hint ?? ''), /Use --udid SIM-001 for Apple devices\./);
});

test('matching selector/platform pairs still resolve', async () => {
  assert.equal(
    (await resolveDevice([ANDROID], { platform: 'android', serial: 'emulator-5580' })).id,
    'emulator-5580',
  );
  assert.equal((await resolveDevice([APPLE], { platform: 'ios', udid: 'SIM-001' })).id, 'SIM-001');
});

test('an unspecified platform keeps the existing device-not-found behavior', async () => {
  const error = await resolveError([ANDROID], { udid: 'emulator-5580' });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
});

async function resolveError(
  devices: DeviceInfo[],
  selector: Parameters<typeof resolveDevice>[1],
): Promise<AppError> {
  try {
    await resolveDevice(devices, selector);
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected resolution to fail' });
}
