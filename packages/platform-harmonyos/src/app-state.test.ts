import { expect, test, vi } from 'vitest';

vi.mock('./hdc.ts', () => ({ runHarmonyShell: vi.fn() }));

import { runHarmonyShell } from './hdc.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parseHarmonyForegroundRead, probeHarmonyForegroundBundle } from './app-state.ts';

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
    parseHarmonyForegroundRead(`
      Mission ID #57  mission name #[#com.huawei.hmos.settings:phone_settings:com.huawei.hmos.settings.MainAbility]
        state #BACKGROUND
      Mission ID #76  mission name #[#com.example.application:entry:EntryAbility]
        state #FOREGROUND
    `),
  ).toEqual({ kind: 'foreground', package: 'com.example.application', activity: 'EntryAbility' });
});

test('classifies a mission list without a foreground mission as no-foreground-mission', () => {
  expect(parseHarmonyForegroundRead('Mission ID #57 state #BACKGROUND')).toEqual({
    kind: 'no-foreground-mission',
  });
});

test('classifies a dump with section headers but no mission block as no-foreground-mission', () => {
  // A keyguard that hides the mission list answers with the dump's headers
  // and no Mission ID block: the read read the device, not a dead pipe.
  expect(parseHarmonyForegroundRead('User ID #100\n')).toEqual({
    kind: 'no-foreground-mission',
  });
});

test('classifies output with no mission list as unparseable', () => {
  expect(parseHarmonyForegroundRead('')).toEqual({ kind: 'unparseable' });
  expect(parseHarmonyForegroundRead('aa: error: dump failed')).toEqual({ kind: 'unparseable' });
});

test('classifies a foreground mission whose name did not parse as unparseable', () => {
  expect(
    parseHarmonyForegroundRead(`
      Mission ID #57  mission name #[malformed
        state #FOREGROUND
    `),
  ).toEqual({ kind: 'unparseable' });
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
