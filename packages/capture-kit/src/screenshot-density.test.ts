import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { assertSupportedScreenshotPixelDensity } from './screenshot-density.ts';

type Device = Pick<DeviceInfo, 'platform' | 'appleOs' | 'kind'>;
const simulator: Device = { platform: 'apple', appleOs: 'ios', kind: 'simulator' };
const android: Device = { platform: 'android', kind: 'emulator' };

test('native density is accepted on iOS simulators', () => {
  assert.doesNotThrow(() => assertSupportedScreenshotPixelDensity(simulator, undefined, true));
});

test('native density and an explicit density are refused together', () => {
  assert.throws(
    () => assertSupportedScreenshotPixelDensity(simulator, 2, true),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('native density is refused where density is unsupported', () => {
  assert.throws(
    () => assertSupportedScreenshotPixelDensity(android, undefined, true),
    (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_OPERATION',
  );
});
