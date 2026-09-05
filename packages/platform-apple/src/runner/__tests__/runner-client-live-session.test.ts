import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { hasLiveIosRunnerSession } from '../runner-client.ts';
import { withAppleRunnerProvider } from '../runner-provider.ts';

const simulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-live',
  name: 'iPhone',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

test('the local runner is live only while its session registry holds an alive session', () => {
  expect(hasLiveIosRunnerSession(simulator)).toBe(false);
});

test('a scoped provider without startup cost counts as live', async () => {
  await withAppleRunnerProvider(
    async () => ({}),
    { deviceId: simulator.id },
    async () => {
      expect(hasLiveIosRunnerSession(simulator)).toBe(true);
    },
  );
});

test('a scoped provider that tracks its own sessions answers for itself', async () => {
  await withAppleRunnerProvider(
    { runCommand: async () => ({}), hasLiveSession: () => false },
    { deviceId: simulator.id },
    async () => {
      expect(hasLiveIosRunnerSession(simulator)).toBe(false);
    },
  );
});

test('a non-iOS device never reports a live iOS runner', () => {
  expect(hasLiveIosRunnerSession({ ...simulator, appleOs: 'macos', kind: 'device' })).toBe(false);
});
