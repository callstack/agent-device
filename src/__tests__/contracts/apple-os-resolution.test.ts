import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveDeviceAppleOs } from '@agent-device/kernel/device';
import {
  IOS_DEVICE,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
} from '../test-utils/device-fixtures.ts';

test('resolveDeviceAppleOs prefers the stored discriminant, else infers from target', () => {
  assert.equal(resolveDeviceAppleOs(IPADOS_SIMULATOR), 'ipados');
  assert.equal(resolveDeviceAppleOs(VISIONOS_SIMULATOR), 'visionos');
  assert.equal(resolveDeviceAppleOs(IOS_SIMULATOR), 'ios');
  assert.equal(resolveDeviceAppleOs(IOS_DEVICE), 'ios');
  assert.equal(resolveDeviceAppleOs(TVOS_SIMULATOR), 'tvos');
  assert.equal(resolveDeviceAppleOs(MACOS_DEVICE), 'macos');
});
