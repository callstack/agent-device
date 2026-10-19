import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  ANDROID_EMULATOR,
  IOS_DEVICE,
  IOS_SIMULATOR,
  createLiveTestHostEnvironment,
} from '@agent-device/test-kit';
import { createPlatformResourceCleanup } from './platform-runtime-resource-cleanup.ts';

const platformResourceCleanup = createPlatformResourceCleanup(createLiveTestHostEnvironment());

const PLAIN_CLOSE = { shutdownRequested: false, hasScreenRecording: false, hasLease: false };

function retains(device: DeviceInfo, overrides: Partial<typeof PLAIN_CLOSE> = {}): boolean {
  return platformResourceCleanup.retainExecutionHostAfterClose({
    device,
    ...PLAIN_CLOSE,
    ...overrides,
  });
}

test('a plain close keeps the runner host of an iOS simulator', () => {
  expect(retains(IOS_SIMULATOR)).toBe(true);
  expect(retains({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulator-set' })).toBe(true);
});

test.each([
  { name: 'a shutdown request', overrides: { shutdownRequested: true } },
  { name: 'a live screen recording', overrides: { hasScreenRecording: true } },
  { name: 'a lease', overrides: { hasLease: true } },
])('$name releases the runner host of an iOS simulator', ({ overrides }) => {
  expect(retains(IOS_SIMULATOR, overrides)).toBe(false);
});

test('a physical iOS device and a non-Apple device keep no runner host', () => {
  expect(retains(IOS_DEVICE)).toBe(false);
  expect(retains(ANDROID_EMULATOR)).toBe(false);
});
