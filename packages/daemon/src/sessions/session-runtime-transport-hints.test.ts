import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { applyDeviceDefaultMetroHost, runtimeHintValues } from './session-runtime.ts';

const ANDROID_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel 8',
  kind: 'emulator',
  booted: true,
};

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 16',
  kind: 'simulator',
  booted: true,
};

test.each([
  ['Android emulator', { platform: 'android', metroPort: 8084 }, ANDROID_EMULATOR, '10.0.2.2'],
  ['iOS simulator', { platform: 'ios', metroPort: 8084 }, IOS_SIMULATOR, '127.0.0.1'],
] as const)(
  '%s port-only runtime hints get the device loopback host',
  (_label, runtime, device, host) => {
    assert.deepEqual(applyDeviceDefaultMetroHost(runtime, device), { ...runtime, metroHost: host });
  },
);

test('physical Android port-only runtime hints stay ambiguous', () => {
  const runtime = { platform: 'android', metroPort: 8084 } as const;
  const device: DeviceInfo = { ...ANDROID_EMULATOR, id: 'R5CN30', kind: 'device' };

  assert.equal(applyDeviceDefaultMetroHost(runtime, device), runtime);
});

test('runtime hint values serialize the configured fields and port', () => {
  assert.deepEqual(
    runtimeHintValues({
      platform: 'android',
      metroHost: '10.0.0.10',
      metroPort: 8084,
      bundleUrl: 'https://10.0.0.10:8084/index.bundle',
      launchUrl: 'demo://open',
    }),
    {
      metroHost: '10.0.0.10',
      metroPort: '8084',
      bundleUrl: 'https://10.0.0.10:8084/index.bundle',
      launchUrl: 'demo://open',
    },
  );
});
