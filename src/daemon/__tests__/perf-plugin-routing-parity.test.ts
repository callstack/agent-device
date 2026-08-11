import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isIosFamily,
  isMacOs,
  DEVICE_TARGETS,
  PLATFORMS,
  type DeviceInfo,
  type DeviceKind,
  type DeviceTarget,
} from '@agent-device/kernel/device';
import {
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  IOS_DEVICE,
  IOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from '../../__tests__/test-utils/index.ts';
import { getPlugin } from '../../core/platform-plugin-registry.ts';
import { registerBuiltinPlatformPlugins } from '../../core/interactors/register-builtins.ts';

registerBuiltinPlatformPlugins();

function supportsPlatformPerfObservationsByHand(device: DeviceInfo): boolean {
  return (
    device.platform === 'android' ||
    device.platform === 'harmonyos' ||
    isIosFamily(device) ||
    isMacOs(device)
  );
}

const DEVICE_KINDS_ALL: DeviceKind[] = ['simulator', 'emulator', 'device'];
const DEVICE_TARGETS_ALL: (DeviceTarget | undefined)[] = [undefined, ...DEVICE_TARGETS];

function buildDeviceMatrix(): DeviceInfo[] {
  return PLATFORMS.flatMap((platform) =>
    DEVICE_KINDS_ALL.flatMap((kind) =>
      DEVICE_TARGETS_ALL.map((target) => ({
        platform,
        id: `${platform}-${kind}-${target ?? 'none'}`,
        name: `${platform} ${kind} ${target ?? 'none'}`,
        kind,
        ...(target ? { target } : {}),
        booted: true,
      })),
    ),
  );
}

const SAMPLE_DEVICES: DeviceInfo[] = [
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  IOS_DEVICE,
  IOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
  ...buildDeviceMatrix(),
];

test('perf support facet matches explicit frame and memory observation support', () => {
  for (const device of SAMPLE_DEVICES) {
    assert.equal(
      getPlugin(device.platform).perf?.supportsObservations(device) ?? false,
      supportsPlatformPerfObservationsByHand(device),
      `perf observation support for ${device.id}`,
    );
  }
});

test('only families with explicit perf observations carry the perf facet', () => {
  assert.ok(getPlugin('apple').perf, 'apple plugin exposes perf');
  assert.ok(getPlugin('android').perf, 'android plugin exposes perf');
  assert.ok(getPlugin('harmonyos').perf, 'harmonyos plugin exposes perf');
  assert.equal(getPlugin('linux').perf, undefined, 'linux plugin has no perf');
  assert.equal(getPlugin('web').perf, undefined, 'web plugin has no perf');
});
