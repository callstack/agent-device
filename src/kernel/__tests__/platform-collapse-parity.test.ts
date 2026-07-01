import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deviceFieldsFromPublicPlatform,
  isIosFamily,
  isMacOs,
  isMobilePlatform,
  matchesPlatformSelector,
  publicPlatformString,
  resolveDevice,
  type DeviceInfo,
} from '../device.ts';
import {
  ANDROID_EMULATOR,
  IOS_DEVICE,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from '../../__tests__/test-utils/device-fixtures.ts';
import { readReplayScriptMetadata, writeReplayScript } from '../../replay/script.ts';
import type { SessionState } from '../../daemon/types.ts';

// Parity gate for the ios/macos -> apple Platform collapse (issue #979, approach b).
// Internal `DeviceInfo.platform` is `apple`; the daemon still ACCEPTS the legacy
// `ios`/`macos` selectors and still EMITS the leaf `ios`/`macos` strings. These tests
// pin the read-path resolution and the output-projection so the collapse stays
// non-breaking for machine consumers.

const APPLE_NON_MACOS: DeviceInfo[] = [
  IOS_SIMULATOR,
  IOS_DEVICE,
  IPADOS_SIMULATOR,
  VISIONOS_SIMULATOR,
  TVOS_SIMULATOR,
];
const NON_APPLE: DeviceInfo[] = [ANDROID_EMULATOR, LINUX_DEVICE, WEB_DESKTOP_DEVICE];

test('OUTPUT: publicPlatformString emits the pre-collapse leaf for every fixture', () => {
  for (const device of APPLE_NON_MACOS) {
    assert.equal(publicPlatformString(device), 'ios', device.name);
  }
  assert.equal(publicPlatformString(MACOS_DEVICE), 'macos');
  assert.equal(publicPlatformString(ANDROID_EMULATOR), 'android');
  assert.equal(publicPlatformString(LINUX_DEVICE), 'linux');
  assert.equal(publicPlatformString(WEB_DESKTOP_DEVICE), 'web');
});

test('OUTPUT: publicPlatformString honors legacy leaf `platform` records', () => {
  // Persisted pre-collapse records may still carry the leaf platform string.
  assert.equal(publicPlatformString({ platform: 'macos' as never }), 'macos');
  assert.equal(publicPlatformString({ platform: 'ios' as never }), 'ios');
});

test('READ: the `apple` selector matches exactly the Apple family', () => {
  for (const device of [...APPLE_NON_MACOS, MACOS_DEVICE]) {
    assert.equal(matchesPlatformSelector(device, 'apple'), true, device.name);
  }
  for (const device of NON_APPLE) {
    assert.equal(matchesPlatformSelector(device, 'apple'), false, device.name);
  }
});

test('READ: legacy `ios`/`macos` selectors resolve within the collapsed platform', () => {
  // `--platform ios` = every Apple OS except the macOS host.
  for (const device of APPLE_NON_MACOS) {
    assert.equal(matchesPlatformSelector(device, 'ios'), true, device.name);
  }
  assert.equal(matchesPlatformSelector(MACOS_DEVICE, 'ios'), false);
  // `--platform macos` = the macOS host only.
  assert.equal(matchesPlatformSelector(MACOS_DEVICE, 'macos'), true);
  for (const device of APPLE_NON_MACOS) {
    assert.equal(matchesPlatformSelector(device, 'macos'), false, device.name);
  }
});

test('READ: --platform apple and --platform ios resolve to the same device', async () => {
  const devices = [IOS_SIMULATOR, ANDROID_EMULATOR];
  const viaApple = await resolveDevice(devices, { platform: 'apple' });
  const viaIos = await resolveDevice(devices, { platform: 'ios' });
  assert.deepEqual(viaApple, viaIos);
  assert.equal(viaApple.id, IOS_SIMULATOR.id);
});

test('deviceFieldsFromPublicPlatform is the inverse projection of publicPlatformString', () => {
  assert.deepEqual(deviceFieldsFromPublicPlatform('macos'), {
    platform: 'apple',
    appleOs: 'macos',
  });
  assert.deepEqual(deviceFieldsFromPublicPlatform('ios'), { platform: 'apple' });
  assert.deepEqual(deviceFieldsFromPublicPlatform('android'), { platform: 'android' });
  for (const leaf of ['ios', 'macos', 'android', 'linux', 'web'] as const) {
    assert.equal(publicPlatformString(deviceFieldsFromPublicPlatform(leaf)), leaf);
  }
});

test('predicates preserve the pre-collapse platform families', () => {
  for (const device of APPLE_NON_MACOS) {
    assert.equal(isIosFamily(device), true, device.name);
    assert.equal(isMacOs(device), false, device.name);
    assert.equal(isMobilePlatform(device), true, device.name);
  }
  assert.equal(isIosFamily(MACOS_DEVICE), false);
  assert.equal(isMacOs(MACOS_DEVICE), true);
  assert.equal(isMobilePlatform(MACOS_DEVICE), false);
  assert.equal(isMobilePlatform(ANDROID_EMULATOR), true);
  assert.equal(isMobilePlatform(LINUX_DEVICE), false);
});

test('REPLAY: heal-write emits the leaf platform and round-trips through the reader', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-collapse-parity-'));
  for (const device of [IOS_SIMULATOR, TVOS_SIMULATOR, MACOS_DEVICE, ANDROID_EMULATOR]) {
    const session = {
      name: 'parity',
      device,
      createdAt: 0,
      actions: [],
    } as unknown as SessionState;
    const filePath = path.join(dir, `${device.id}.ad`);
    writeReplayScript(filePath, [], session);
    const written = fs.readFileSync(filePath, 'utf8');
    const leaf = publicPlatformString(device);
    assert.match(written, new RegExp(`context platform=${leaf}\\b`), device.name);
    // The reader accepts the emitted leaf and echoes it back unchanged.
    assert.equal(readReplayScriptMetadata(written).platform, leaf, device.name);
  }
  // The reader also accepts the collapsed `apple` selector directly.
  assert.equal(readReplayScriptMetadata('context platform=apple\nhome\n').platform, 'apple');
  fs.rmSync(dir, { recursive: true, force: true });
});
