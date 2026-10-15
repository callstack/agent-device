import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isHandheldAppleDevice,
  isHandheldAppleSimulator,
  resolveDeviceAppleOs,
} from '@agent-device/kernel/device';
import {
  ANDROID_EMULATOR,
  IOS_DEVICE,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
} from '@agent-device/test-kit';

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

test('isHandheldAppleDevice admits iPhone and iPad leaves on simulators, hardware, and legacy records', () => {
  const { appleOs: _appleOs, ...legacyIosDevice } = IOS_DEVICE;
  assert.equal(isHandheldAppleDevice(IOS_SIMULATOR), true);
  assert.equal(isHandheldAppleDevice(IPADOS_SIMULATOR), true);
  assert.equal(isHandheldAppleDevice(IOS_DEVICE), true);
  assert.equal(isHandheldAppleDevice(legacyIosDevice), true);
  assert.equal(isHandheldAppleDevice(TVOS_SIMULATOR), false);
  assert.equal(isHandheldAppleDevice(VISIONOS_SIMULATOR), false);
  assert.equal(isHandheldAppleDevice(MACOS_DEVICE), false);
  assert.equal(isHandheldAppleDevice(ANDROID_EMULATOR), false);
});
