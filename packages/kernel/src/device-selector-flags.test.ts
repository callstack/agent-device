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

test('--platform ios excludes a booted watchOS simulator from phone selection', async () => {
  const watch: DeviceInfo = {
    platform: 'apple',
    target: 'mobile',
    appleOs: 'watchos',
    id: 'WATCH-001',
    name: 'Apple Watch Series 10',
    kind: 'simulator',
    booted: true,
  };
  assert.equal((await resolveDevice([APPLE, watch], { platform: 'ios' })).id, APPLE.id);
  assert.equal((await resolveError([watch], { platform: 'ios' })).code, 'DEVICE_NOT_FOUND');
});

test('an unspecified platform keeps the existing device-not-found behavior', async () => {
  const error = await resolveError([ANDROID], { udid: 'emulator-5580' });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
});

// `--device` takes a NAME. Passing a UDID there answered "No device named <udid>" with the generic
// booted/connected hint (#2064) — true, unactionable, and silent about `--udid` existing at all.

test('a UDID passed to --device names --udid and the device it identifies', async () => {
  const error = await resolveError([APPLE, ANDROID], { deviceName: 'SIM-001' });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
  assert.match(error.message, /No device named SIM-001/);
  assert.match(
    String(error.details?.hint ?? ''),
    /SIM-001 is the id of "iPhone 16", not its name\. Did you mean --udid SIM-001\?/,
  );
});

test('a serial passed to --device names --serial, not --udid', async () => {
  const error = await resolveError([APPLE, ANDROID], { deviceName: 'emulator-5580' });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
  assert.match(String(error.details?.hint ?? ''), /Did you mean --serial emulator-5580\?/);
});

test('an id passed to --device on a platform with no identity flag stays hint-free', async () => {
  // `--udid` resolves only Apple devices and `--serial` only serial-addressable ones; a web or
  // linux device's id has no flag that could take it, so a hint naming one would be unrunnable.
  const WEB: DeviceInfo = {
    platform: 'web',
    target: 'desktop',
    id: 'agent-browser-chrome',
    name: 'Agent Browser Chrome',
    kind: 'device',
    booted: true,
  };
  const error = await resolveError([WEB], { deviceName: 'agent-browser-chrome' });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
  assert.equal(error.details?.hint, undefined);
});

test('an unknown --device value gets the generic hint, even when it looks like a UDID', async () => {
  // The hint is grounded in observed identity: only a candidate's actual id earns the
  // wrong-flag answer. A UDID-shaped value that no listed device carries stays a plain
  // unknown name — guessing from shape would misclassify UUID-named devices and miss
  // every identity syntax the shape guess does not cover.
  for (const deviceName of ['204BFFD9-9644-4830-B2C1-1B946597A07C', 'iPhone 99']) {
    const error = await resolveError([APPLE], { platform: 'ios', deviceName });
    assert.equal(error.code, 'DEVICE_NOT_FOUND');
    assert.equal(error.details?.hint, undefined);
  }
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
