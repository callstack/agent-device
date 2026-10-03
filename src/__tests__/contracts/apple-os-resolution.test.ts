import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isHandheldAppleSimulator, resolveDeviceAppleOs } from '@agent-device/kernel/device';
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

test('isHandheldAppleSimulator admits only an iPhone or iPad simulator leaf', () => {
  // The leaf the content-size ladder lives on: narrower than the iOS family, and excluding both
  // hardware and the macOS host, which is why the ladder's refusal can name one predicate.
  assert.equal(isHandheldAppleSimulator(IOS_SIMULATOR), true);
  assert.equal(isHandheldAppleSimulator(IPADOS_SIMULATOR), true);
  assert.equal(isHandheldAppleSimulator(TVOS_SIMULATOR), false);
  assert.equal(isHandheldAppleSimulator(VISIONOS_SIMULATOR), false);
  assert.equal(isHandheldAppleSimulator(IOS_DEVICE), false);
  assert.equal(isHandheldAppleSimulator(MACOS_DEVICE), false);
});
