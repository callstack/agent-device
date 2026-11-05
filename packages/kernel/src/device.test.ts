import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  canonicalDeviceId,
  devicesOverlap,
  hostAppDevice,
  hostDeviceIdOf,
  isMacOsBundleId,
  resolveDevice,
  webBackendKeyOf,
  webSessionBackendKey,
  webSessionDevice,
  type DeviceInfo,
} from './device.ts';
import { AppError } from './errors.ts';

const mac: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-mac',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
};

test('a host overlaps each of its app devices, and two of its app devices do not overlap', () => {
  const one = hostAppDevice(mac, 'com.example.One').id;
  const two = hostAppDevice(mac, 'com.example.two').id;
  assert.equal(one, hostAppDevice(mac, 'com.example.one').id);
  assert.equal(devicesOverlap(mac.id, one), true);
  assert.equal(devicesOverlap(two, mac.id), true);
  assert.equal(devicesOverlap(one, one), true);
  assert.equal(devicesOverlap(one, two), false);
  assert.equal(devicesOverlap('host-mac-2', one), false);
});

test('hostDeviceIdOf names the host of an app device and any other device itself', () => {
  assert.equal(hostDeviceIdOf(hostAppDevice(mac, 'com.example.one').id), mac.id);
  assert.equal(hostDeviceIdOf(mac.id), mac.id);
  assert.equal(hostDeviceIdOf('emulator-5554'), 'emulator-5554');
});

const browser: DeviceInfo = {
  platform: 'web',
  id: 'agent-browser-chrome',
  name: 'Agent Browser Chrome',
  kind: 'device',
  target: 'desktop',
};

const webDevice = (name: string, tenantId?: string): DeviceInfo =>
  webSessionDevice(browser, tenantId === undefined ? { name } : { name, tenantId });

test('a host overlaps each of its web session devices, and two of its web session devices do not overlap', () => {
  const one = webDevice('one').id;
  const two = webDevice('two').id;
  assert.equal(one, 'agent-browser-chrome:session:p_one');
  assert.equal(devicesOverlap(browser.id, one), true);
  assert.equal(devicesOverlap(two, browser.id), true);
  assert.equal(devicesOverlap(one, one), true);
  assert.equal(devicesOverlap(one, two), false);
  assert.equal(devicesOverlap(one, webDevice('one-two').id), false);
  assert.equal(devicesOverlap(webSessionDevice(mac, { name: 'one' }).id, one), false);
});

test('a web session device id names its host, and its name is case-insensitive', () => {
  const id = webDevice('Run-One').id;
  assert.equal(hostDeviceIdOf(id), browser.id);
  assert.equal(canonicalDeviceId(id), id);
  assert.equal(id, webDevice('run-one').id);
});

test('web session names that differ only by case drive one browser and are one device', () => {
  const one = webDevice('one').id;
  assert.equal(webDevice('ONE').id, one);
  assert.equal(devicesOverlap(webDevice('One').id, one), true);
});

test('the backend key is p_<name>, and t_<hash of the tenant>_<name> under tenant isolation', () => {
  assert.equal(webSessionBackendKey({ name: 'one' }), 'p_one');
  const first = webSessionBackendKey({ name: 'one', tenantId: 'tenant-1' });
  assert.match(first, /^t_[0-9a-f]{12}_one$/);
  assert.equal(first, webSessionBackendKey({ name: 'ONE', tenantId: 'tenant-1' }));
  assert.notEqual(first, webSessionBackendKey({ name: 'one', tenantId: 'tenant-2' }));
  assert.notEqual(first, webSessionBackendKey({ name: 'one' }));
});

test('two tenants using one name hold two devices, and one tenant using it twice holds one', () => {
  assert.notEqual(webDevice('one', 'tenant-1').id, webDevice('one', 'tenant-2').id);
  assert.equal(webDevice('one', 'tenant-1').id, webDevice('one', 'tenant-1').id);
  assert.equal(
    devicesOverlap(webDevice('one', 'tenant-1').id, webDevice('one', 'tenant-2').id),
    false,
  );
  assert.equal(devicesOverlap(browser.id, webDevice('one', 'tenant-1').id), true);
});

test('the backend key reads back from the device id, and only a web session device carries one', () => {
  assert.equal(webBackendKeyOf(webDevice('one').id), 'p_one');
  const tenantKey = webSessionBackendKey({ name: 'one', tenantId: 'tenant-1' });
  assert.equal(webBackendKeyOf(webDevice('one', 'tenant-1').id), tenantKey);
  assert.equal(webBackendKeyOf(browser.id), undefined);
  assert.equal(webBackendKeyOf(hostAppDevice(mac, 'com.example.one').id), undefined);
  assert.equal(webBackendKeyOf('emulator-5554'), undefined);
});

test.each([
  '',
  ' ',
  '\t',
  'one:session:two',
  'one:app:two',
  'a:b',
  ':',
  'a b',
  ' one',
  'one ',
  'one\t',
  'a/b',
  'a.b',
  'é',
  'K',
  'a'.repeat(31),
])('a web session name of %j is refused with a typed reason', (name) => {
  assert.throws(
    () => webDevice(name),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'web_session_name_invalid',
  );
});

test('the longest name leaves a key that fits the socket path, and is shorter under a tenant', () => {
  // 32 characters of key: agent-browser's 103-byte socket path less a 65-byte socket directory and 6 bytes
  // for `/` and `.sock`.
  assert.equal(webSessionBackendKey({ name: 'a'.repeat(30) }).length, 32);
  assert.equal(webSessionBackendKey({ name: 'a'.repeat(17), tenantId: 'tenant-1' }).length, 32);
  assert.throws(
    () => webSessionBackendKey({ name: 'a'.repeat(18), tenantId: 'tenant-1' }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'web_session_name_invalid',
  );
});

test.each(['a', 'run_one-1', '0'])('a web session name of %j is accepted', (name) => {
  assert.equal(webDevice(name).id, `${browser.id}:session:p_${name}`);
});

test('web session names that differ only by case are one device', () => {
  assert.equal(webDevice('Run_One-1').id, `${browser.id}:session:p_run_one-1`);
  assert.equal(webDevice('Checkout').id, webDevice('checkout').id);
});

test.each([
  ['com.apple.TextEdit', true],
  ['com.x.My_App', true],
  ['Foo.Bar', true],
  ['zoom.us', true],
  ['TextEdit', false],
  ['com..x', false],
  ['com.example app', false],
])('isMacOsBundleId(%j) is %s', (value, expected) => {
  assert.equal(isMacOsBundleId(value), expected);
});

const shutDownIphone: DeviceInfo = {
  platform: 'apple',
  id: 'sim-iphone',
  name: 'iPhone 17',
  kind: 'simulator',
  target: 'mobile',
  appleOs: 'ios',
  booted: false,
};

test('an iPad simulator renamed without "iPad" still ranks below an iPhone', async () => {
  const renamedIpad: DeviceInfo = {
    ...shutDownIphone,
    id: 'sim-tablet',
    name: 'Design Review',
    appleOs: 'ipados',
  };
  const selected = await resolveDevice([renamedIpad, shutDownIphone], { platform: 'ios' });
  assert.equal(selected.id, shutDownIphone.id);
});

test('a record without appleOs still ranks as an iPad by its name', async () => {
  const { appleOs: _phoneOs, ...legacyIphone } = shutDownIphone;
  const legacyIpad: DeviceInfo = { ...legacyIphone, id: 'sim-ipad', name: 'iPad Air' };
  const selected = await resolveDevice([legacyIpad, legacyIphone], { platform: 'ios' });
  assert.equal(selected.id, legacyIphone.id);
});
