import { expect, test, vi } from 'vitest';

vi.mock('./hdc.ts', () => ({ runHarmonyShell: vi.fn() }));

import { runHarmonyShell } from './hdc.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parseHarmonyForegroundApp, probeHarmonyForegroundBundle } from './app-state.ts';

const DEVICE: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

test('parses the foreground ability from the mission list', () => {
  expect(
    parseHarmonyForegroundApp(`
      Mission ID #57  mission name #[#com.huawei.hmos.settings:phone_settings:com.huawei.hmos.settings.MainAbility]
        state #BACKGROUND
      Mission ID #76  mission name #[#com.example.application:entry:EntryAbility]
        state #FOREGROUND
    `),
  ).toEqual({ package: 'com.example.application', activity: 'EntryAbility' });
});

test('rejects a mission list without a foreground ability', () => {
  expect(parseHarmonyForegroundApp('Mission ID #57 state #BACKGROUND')).toBeUndefined();
});

test('the open-time probe names the foreground bundle', async () => {
  const hdc = vi.mocked(runHarmonyShell);
  hdc.mockResolvedValue({
    stdout:
      'Mission ID #76  mission name #[#com.example.application:entry:EntryAbility]\n' +
      '  state #FOREGROUND',
    exitCode: 0,
    stderr: '',
  });

  await expect(probeHarmonyForegroundBundle(DEVICE, new AbortController().signal)).resolves.toBe(
    'com.example.application',
  );
});

test('the open-time probe claims nothing when no mission is foreground', async () => {
  const hdc = vi.mocked(runHarmonyShell);
  hdc.mockResolvedValue({
    stdout: 'Mission ID #57 state #BACKGROUND',
    exitCode: 0,
    stderr: '',
  });

  await expect(
    probeHarmonyForegroundBundle(DEVICE, new AbortController().signal),
  ).resolves.toBeUndefined();
});

test('the open-time probe claims nothing when the device read fails', async () => {
  const hdc = vi.mocked(runHarmonyShell);
  hdc.mockRejectedValue(new Error('device offline'));

  await expect(
    probeHarmonyForegroundBundle(DEVICE, new AbortController().signal),
  ).resolves.toBeUndefined();
});
