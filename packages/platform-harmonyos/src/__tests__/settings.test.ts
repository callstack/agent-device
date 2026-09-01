import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

vi.mock('../hdc.ts', () => ({ runHarmonyHdc: vi.fn() }));

import { runHarmonyHdc } from '../hdc.ts';
import { setHarmonySetting } from '../settings.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'emulator',
  name: 'emulator',
  kind: 'emulator',
  booted: true,
};
const mockRunHarmonyHdc = vi.mocked(runHarmonyHdc);

beforeEach(() => {
  mockRunHarmonyHdc.mockReset();
  mockRunHarmonyHdc.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);
});

test('HarmonyOS clear-app-state force stops then clears bundle data and cache', async () => {
  await assert.doesNotReject(async () => {
    assert.deepEqual(
      await setHarmonySetting(device, 'clear-app-state', 'clear', 'com.example.application'),
      {
        bundleId: 'com.example.application',
        forceStopped: true,
        clearedData: true,
        clearedCache: true,
      },
    );
  });
  assert.deepEqual(
    mockRunHarmonyHdc.mock.calls.map((call) => call[1]),
    [
      ['shell', 'aa', 'force-stop', 'com.example.application'],
      ['shell', 'bm', 'clean', '-n', 'com.example.application', '-d', '-c'],
    ],
  );
});

test('HarmonyOS settings rejects unsupported setting and missing app bundle', async () => {
  await assert.rejects(async () => await setHarmonySetting(device, 'wifi', 'on'), /not supported/);
  await assert.rejects(
    async () => await setHarmonySetting(device, 'clear-app-state', 'clear'),
    /requires an app id/,
  );
});
