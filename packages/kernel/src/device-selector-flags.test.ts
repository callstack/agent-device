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

// With no explicit --platform there is no pairing to reject: the value reaches resolution and
// fails as "No Apple device with UDID ..." — literally true, and silent about the flag that does
// take it. When the value identifies an observed device through the OTHER flag, the failure names
// that flag, read through deviceIdentityFlag rather than a new inline pairing.

test('--udid with no --platform names --serial when the value is an attached serial', async () => {
  const error = await resolveError([ANDROID], { udid: 'emulator-5580' });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
  assert.match(error.message, /No Apple device with UDID emulator-5580/);
  assert.match(
    String(error.details?.hint ?? ''),
    /emulator-5580 identifies "Pixel 7" here\. Did you mean --serial emulator-5580\?/,
  );
});

test('--serial with no --platform names --udid when the value is an attached UDID', async () => {
  const error = await resolveError([APPLE], { serial: 'SIM-001' });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
  assert.match(
    String(error.details?.hint ?? ''),
    /SIM-001 identifies "iPhone 16" here\. Did you mean --udid SIM-001\?/,
  );
});

test('a serial-side hint names --serial for harmonyos and vega devices too', async () => {
  const VEGA: DeviceInfo = {
    platform: 'vega',
    target: 'mobile',
    id: 'vvd-42',
    name: 'Vega VVD',
    kind: 'device',
    booted: true,
  };
  const error = await resolveError([VEGA], { udid: 'vvd-42' });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
  assert.match(String(error.details?.hint ?? ''), /Did you mean --serial vvd-42\?/);
});

test('an identity value that matches no candidate stays hint-free', async () => {
  // The hint is grounded in observed identity: a value nothing carries earns no flag answer,
  // exactly like the --device name hint below.
  const udid = await resolveError([ANDROID], { udid: 'not-attached' });
  assert.equal(udid.code, 'DEVICE_NOT_FOUND');
  assert.equal(udid.details?.hint, undefined);
  const serial = await resolveError([APPLE], { serial: 'not-attached' });
  assert.equal(serial.code, 'DEVICE_NOT_FOUND');
  assert.equal(serial.details?.hint, undefined);
});

test('a web-device id passed to --udid stays hint-free', async () => {
  // --udid resolves only Apple devices and --serial only serial-addressable ones; a platform with
  // no identity flag has no flag that could take the value, so a hint naming one is unrunnable.
  const WEB: DeviceInfo = {
    platform: 'web',
    target: 'desktop',
    id: 'agent-browser-chrome',
    name: 'Agent Browser Chrome',
    kind: 'device',
    booted: true,
  };
  const error = await resolveError([WEB], { udid: 'agent-browser-chrome' });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
  assert.equal(error.details?.hint, undefined);
});

// Resolution fails before any device is touched, so the refusal proves nothing was dispatched.
test('a device-not-found refusal discloses that nothing was dispatched', async () => {
  for (const selector of [
    { udid: 'emulator-5580' },
    { deviceName: 'Nope' },
    { platform: 'android' as const, serial: 'nope' },
  ]) {
    const error = await resolveError([ANDROID], selector);
    assert.equal(error.code, 'DEVICE_NOT_FOUND');
    assert.equal(error.details?.dispatched, 'no');
  }
  const empty = await resolveError([], {});
  assert.equal(empty.details?.dispatched, 'no');
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

// `--device` already folds case, underscores, and whitespace when comparing names; quote STYLE is
// the fold it lacks, and renamed devices carry curly quotes a typed request spells straight. When
// that one fold matches exactly one candidate, the failure names it.

test('a name differing only in curly quotes is answered with the candidate name', async () => {
  const CURLED: DeviceInfo = { ...APPLE, id: 'SIM-002', name: 'iPhone “16”' };
  const error = await resolveError([CURLED, ANDROID], { deviceName: 'iPhone "16"' });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
  assert.match(error.message, /No device named iPhone "16"/);
  assert.match(
    String(error.details?.hint ?? ''),
    /A device is named "iPhone “16”", which differs only in punctuation\. Did you mean --device "iPhone “16”"\?/,
  );
});

test('a curly single-quote name folds onto a straight-quote request', async () => {
  const CURLED: DeviceInfo = { ...ANDROID, id: 'emulator-5581', name: 'Pixel ‘7’' };
  const error = await resolveError([CURLED], { deviceName: "Pixel '7'" });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
  assert.match(String(error.details?.hint ?? ''), /Did you mean --device "Pixel ‘7’"\?/);
});

test('a name two candidates share under the quote fold earns no hint', async () => {
  // Both candidates fold onto the straight-quote request — one spelled with U+2018 quotes, one
  // with U+2019 — so the request cannot tell them apart. The request keeps its quotes: a
  // quote-less request would fold onto neither candidate and make this case vacuous.
  const CURLED_A: DeviceInfo = { ...ANDROID, id: 'emulator-5581', name: 'Pixel ‘7‘' };
  const CURLED_B: DeviceInfo = { ...ANDROID, id: 'emulator-5582', name: 'Pixel ’7’' };
  const error = await resolveError([CURLED_A, CURLED_B], { deviceName: "Pixel '7'" });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
  assert.equal(error.details?.hint, undefined);
});

test('a name the quote fold cannot reach stays hint-free', async () => {
  const error = await resolveError([APPLE], { deviceName: 'iPhone 17' });
  assert.equal(error.code, 'DEVICE_NOT_FOUND');
  assert.equal(error.details?.hint, undefined);
});

test('an id passed to --device still wins over the closest-name fold', async () => {
  // The identity answer is the sharper one: the value belongs to a different flag entirely, so it
  // outranks a punctuation-level name guess.
  const error = await resolveError([APPLE], { deviceName: 'SIM-001' });
  assert.match(String(error.details?.hint ?? ''), /is the id of "iPhone 16", not its name/);
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
