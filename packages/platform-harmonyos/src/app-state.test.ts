import { afterEach, expect, test, vi } from 'vitest';

import type { HarmonyHdcRunner } from './hdc.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parseHarmonyForegroundRead, probeHarmonyForegroundBundle } from './app-state.ts';

const runHarmonyShell = vi.fn<HarmonyHdcRunner['runShell']>();
const hdcRunner = { runShell: runHarmonyShell };

const DEVICE: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

afterEach(() => {
  vi.useRealTimers();
});

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

  await expect(probeHarmonyForegroundBundle(hdcRunner, DEVICE, new AbortController().signal)).resolves.toBe(
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
    probeHarmonyForegroundBundle(hdcRunner, DEVICE, new AbortController().signal),
  ).resolves.toBeUndefined();
});

test('the open-time probe claims nothing when the device read fails', async () => {
  const hdc = vi.mocked(runHarmonyShell);
  hdc.mockRejectedValue(new Error('device offline'));

  await expect(
    probeHarmonyForegroundBundle(hdcRunner, DEVICE, new AbortController().signal),
  ).resolves.toBeUndefined();
});

test('the open-time probe keeps its 15s read when no request deadline bounds it', async () => {
  vi.mocked(runHarmonyShell).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

  await probeHarmonyForegroundBundle(hdcRunner, DEVICE, new AbortController().signal);

  expect(vi.mocked(runHarmonyShell).mock.calls[0]?.[2]?.timeoutMs).toBe(15_000);
});

test('the open-time probe keeps its 15s read under a far request deadline', async () => {
  vi.mocked(runHarmonyShell).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

  await probeHarmonyForegroundBundle(hdcRunner, DEVICE, new AbortController().signal, {
    deadlineAtMs: Date.now() + 60_000,
  });

  expect(vi.mocked(runHarmonyShell).mock.calls[0]?.[2]?.timeoutMs).toBe(15_000);
});

test('the open-time probe clamps its read to the request deadline room left', async () => {
  vi.mocked(runHarmonyShell).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

  // A deadline with 2s left bounds the probe below its 15s default, so a hung
  // `aa dump -l` cannot hold the dispatch past the request budget (#4860).
  await probeHarmonyForegroundBundle(hdcRunner, DEVICE, new AbortController().signal, {
    deadlineAtMs: Date.now() + 2_000,
  });

  const timeoutMs = vi.mocked(runHarmonyShell).mock.calls[0]?.[2]?.timeoutMs;
  expect(timeoutMs).toBeGreaterThan(0);
  expect(timeoutMs).toBeLessThanOrEqual(2_000);
});

test('the open-time probe reads nothing when the request deadline has no room left', async () => {
  const hdc = vi.mocked(runHarmonyShell);

  // A spent deadline arms no read at all: the probe claims nothing without
  // touching the device, the same no-room rule the post-open poll runs under.
  await expect(
    probeHarmonyForegroundBundle(hdcRunner, DEVICE, new AbortController().signal, {
      deadlineAtMs: Date.now() - 1_000,
    }),
  ).resolves.toBeUndefined();
  expect(hdc.mock.calls.length).toBe(0);
});

test('a read bounded by the clamped deadline gives up in time instead of holding the open', async () => {
  vi.useFakeTimers();
  // The mock carries the real hdc run's contract: the read hangs until the
  // timeout the probe armed fires.
  vi.mocked(runHarmonyShell).mockImplementation(async (_device, _words, options) => {
    return await new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('hdc timed out')), options?.timeoutMs ?? 0);
    });
  });

  const pending = probeHarmonyForegroundBundle(hdcRunner, DEVICE, new AbortController().signal, {
    deadlineAtMs: Date.now() + 2_000,
  });
  await vi.advanceTimersByTimeAsync(3_000);

  // The deadline-canceled probe surfaces through the advisory outcome it
  // already had: claims nothing, no new failure class, no hang.
  await expect(pending).resolves.toBeUndefined();
});

test('the open-time probe claims nothing when the request aborts mid-read', async () => {
  const controller = new AbortController();
  // The mock carries the real hdc run's abort contract.
  vi.mocked(runHarmonyShell).mockImplementation(async (_device, _words, options) => {
    return await new Promise((_resolve, reject) => {
      const onAbort = (): void => reject(new Error('read canceled'));
      if (options?.signal?.aborted) {
        onAbort();
        return;
      }
      options?.signal?.addEventListener('abort', onAbort, { once: true });
    });
  });

  const pending = probeHarmonyForegroundBundle(hdcRunner, DEVICE, controller.signal, {
    deadlineAtMs: Date.now() + 60_000,
  });
  controller.abort(new Error('request canceled'));

  await expect(pending).resolves.toBeUndefined();
});
