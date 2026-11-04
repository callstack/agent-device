import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  canonicalDeviceId,
  devicesOverlap,
  hostAppDevice,
  hostDeviceIdOf,
  isMacOsBundleId,
  normalizeWebSessionName,
  resolveDevice,
  WEB_BACKEND_KEY_MAX_LENGTH,
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

test('a host overlaps each of its web session devices, and two of its web session devices do not overlap', () => {
  const one = webSessionDevice(browser, 'one').id;
  const two = webSessionDevice(browser, 'two').id;
  assert.equal(one, 'agent-browser-chrome:session:one');
  assert.equal(devicesOverlap(browser.id, one), true);
  assert.equal(devicesOverlap(two, browser.id), true);
  assert.equal(devicesOverlap(one, one), true);
  assert.equal(devicesOverlap(one, two), false);
  assert.equal(devicesOverlap(one, webSessionDevice(browser, 'one-two').id), false);
  assert.equal(devicesOverlap(webSessionDevice(mac, 'one').id, one), false);
});

test('a web session device id names its host and keeps the name case-sensitive', () => {
  const id = webSessionDevice(browser, 'Run-One').id;
  assert.equal(hostDeviceIdOf(id), browser.id);
  assert.equal(canonicalDeviceId(id), id);
  assert.notEqual(id, webSessionDevice(browser, 'run-one').id);
});

test('web session names that drive one browser are one device', () => {
  const one = webSessionDevice(browser, 'one').id;
  assert.equal(webSessionDevice(browser, 'one ').id, one);
  assert.equal(webSessionDevice(browser, ' one').id, one);
  assert.equal(devicesOverlap(webSessionDevice(browser, 'one\t').id, one), true);
  assert.equal(normalizeWebSessionName(' one '), 'one');
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
  'a/b',
  'a.b',
  'é',
  'a'.repeat(WEB_BACKEND_KEY_MAX_LENGTH + 1),
])('a web session name of %j is refused with a typed reason', (name) => {
  assert.throws(
    () => webSessionDevice(browser, name),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'web_session_name_invalid',
  );
});

test.each(['a', 'Run_One-1', '0', 'a'.repeat(WEB_BACKEND_KEY_MAX_LENGTH)])(
  'a web session name of %j is accepted',
  (name) => {
    assert.equal(webSessionDevice(browser, name).id, `${browser.id}:session:${name}`);
  },
);

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
