import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});

import { runCmd } from '@agent-device/host-kit/command';
import { createSystemSurfacePresenceProbe } from './system-surface-presence.ts';

const mockRunCmd = vi.mocked(runCmd);

const sim = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'UDID-1',
  name: 'iPhone',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;

function psLine(...parts: string[]): string {
  return parts.join(' ');
}

beforeEach(() => {
  vi.resetAllMocks();
});

test('detects a registered host process scoped to the device', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stderr: '',
    stdout: psLine('900', '/…/SafariViewService.app/SafariViewService', 'SIMULATOR_UDID=UDID-1'),
  });
  const probe = createSystemSurfacePresenceProbe();
  await expect(probe(sim)).resolves.toBe(true);
});

test('ignores the same host running for a different device', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stderr: '',
    stdout: psLine('900', '/…/SafariViewService.app/SafariViewService', 'SIMULATOR_UDID=OTHER'),
  });
  const probe = createSystemSurfacePresenceProbe();
  await expect(probe(sim)).resolves.toBe(false);
});

test('reports absent when no registered host is running', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stderr: '',
    stdout: psLine('900', '/…/MobileSafari.app/MobileSafari', 'SIMULATOR_UDID=UDID-1'),
  });
  const probe = createSystemSurfacePresenceProbe();
  await expect(probe(sim)).resolves.toBe(false);
});

test('a non-simulator never probes', async () => {
  const probe = createSystemSurfacePresenceProbe();
  await expect(probe({ ...sim, kind: 'device' } as DeviceInfo)).resolves.toBe(false);
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('a probe failure fails safe to the bridge path', async () => {
  mockRunCmd.mockRejectedValue(new Error('ps unavailable'));
  const probe = createSystemSurfacePresenceProbe();
  await expect(probe(sim)).resolves.toBe(false);
});

test('memoizes within the TTL and re-probes after it', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stderr: '',
    stdout: psLine('900', '/…/SafariViewService.app/SafariViewService', 'SIMULATOR_UDID=UDID-1'),
  });
  let clock = 1_000;
  const probe = createSystemSurfacePresenceProbe(() => clock);
  await probe(sim);
  await probe(sim);
  expect(mockRunCmd).toHaveBeenCalledOnce();
  clock += 2_000; // past the TTL
  await probe(sim);
  expect(mockRunCmd).toHaveBeenCalledTimes(2);
});
