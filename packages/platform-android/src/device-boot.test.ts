import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import { observeAndroidBootTimeMs } from './device-boot.ts';

const DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

const NOW_MS = 1_700_000_000_000;

function answersUptime(stdout: string, exitCode = 0) {
  let received: { serial: string; args: string[] } | undefined;
  bindAndroidAdbHostStub({
    execSerialAdb: async (serial, args) => {
      received = { serial, args };
      return { exitCode, stdout, stderr: '' };
    },
  });
  return () => received;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW_MS });
});

afterEach(() => {
  vi.useRealTimers();
});

test('derives the boot instant from the uptime duration on the host clock', async () => {
  const received = answersUptime('120.45 300.12\n');

  assert.deepEqual(await observeAndroidBootTimeMs(DEVICE), {
    observed: true,
    bootedAtMs: NOW_MS - 120_450,
  });
  assert.deepEqual(received(), {
    serial: 'emulator-5554',
    args: ['shell', 'cat', '/proc/uptime'],
  });
});

test('a slow uptime answer cannot move the boot instant past the moment the probe began', async () => {
  bindAndroidAdbHostStub({
    execSerialAdb: async () => {
      vi.setSystemTime(NOW_MS + 4_000);
      return { exitCode: 0, stdout: '120.45 0', stderr: '' };
    },
  });

  assert.deepEqual(await observeAndroidBootTimeMs(DEVICE), {
    observed: true,
    bootedAtMs: NOW_MS - 120_450,
  });
});

test('a refused or unreadable uptime answers nothing', async () => {
  for (const stdout of ['', 'cat: /proc/uptime: Permission denied', 'not-a-number 0']) {
    answersUptime(stdout);
    assert.deepEqual(await observeAndroidBootTimeMs(DEVICE), {
      observed: false,
      reason: 'unobserved',
    });
  }

  answersUptime('120.45 0', 1);
  assert.deepEqual(await observeAndroidBootTimeMs(DEVICE), {
    observed: false,
    reason: 'unobserved',
  });
});
