import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { createHarmonyHdcRunnerStub, type HarmonyHdcRunnerStub } from '../toolbox.fixtures.ts';
import { setHarmonySetting } from '../settings.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, PRE_DISPATCH_REFUSAL_REASONS } from '@agent-device/kernel/errors';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'emulator',
  name: 'emulator',
  kind: 'emulator',
  booted: true,
};

let hdc: HarmonyHdcRunnerStub;

beforeEach(() => {
  hdc = createHarmonyHdcRunnerStub();
});

test('HarmonyOS clear-app-state force stops then clears bundle data and cache', async () => {
  await assert.doesNotReject(async () => {
    assert.deepEqual(
      await setHarmonySetting(hdc, device, 'clear-app-state', 'clear', 'com.example.application'),
      {
        bundleId: 'com.example.application',
        forceStopped: true,
        clearedData: true,
        clearedCache: true,
      },
    );
  });
  assert.deepEqual(
    hdc.calls.map((call) => call.args),
    [
      ['aa', 'force-stop', 'com.example.application'],
      ['bm', 'clean', '-n', 'com.example.application', '-d', '-c'],
    ],
  );
});

test('HarmonyOS settings rejects unsupported setting and missing app bundle', async () => {
  await assert.rejects(
    async () => await setHarmonySetting(hdc, device, 'wifi', 'on'),
    /not supported/,
  );
  await assert.rejects(
    async () => await setHarmonySetting(hdc, device, 'clear-app-state', 'clear'),
    (error: unknown) =>
      error instanceof AppError &&
      error.message.includes('requires an app id') &&
      error.details?.reason === PRE_DISPATCH_REFUSAL_REASONS.sessionAppRequired &&
      error.details?.dispatched === 'no',
  );
  // Both refusals answered before any HDC call.
  assert.equal(hdc.calls.length, 0);
});
