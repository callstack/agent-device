import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { deviceClaimFilePath } from '@agent-device/test-kit';
import { resolveDeviceClaimPath } from './device-claim-paths.ts';

const DEVICE_KEYS = ['local:android:none:emulator-5554', 'local:ios:ios:ABCD-1234'];

test('the claim file path test-kit restates matches the production resolver', () => {
  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', '');
  for (const key of DEVICE_KEYS) {
    expect(deviceClaimFilePath(key)).toBe(resolveDeviceClaimPath(key, process.env));
  }
});

test('the restated path follows the claims directory override like the resolver', () => {
  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', path.join(path.sep, 'tmp', 'agent-device-claims-override'));
  for (const key of DEVICE_KEYS) {
    expect(deviceClaimFilePath(key)).toBe(resolveDeviceClaimPath(key, process.env));
    expect(path.isAbsolute(deviceClaimFilePath(key))).toBe(true);
  }
});
