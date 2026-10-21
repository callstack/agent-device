import { expect, test } from 'vitest';
import { hostAppDevice, type DeviceInfo } from '@agent-device/kernel/device';
import { appleAudioProbeCaptureFact } from './runtime.ts';

const mac: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-mac',
  name: 'Mac',
  kind: 'device',
  target: 'desktop',
};

test('an app device of the Mac refuses audio probe, which samples the whole Mac', () => {
  expect(appleAudioProbeCaptureFact(hostAppDevice(mac, 'com.example.app'))).toMatchObject({
    available: false,
    reason: 'unsupported-device-scope',
  });
});
