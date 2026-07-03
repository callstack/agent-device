import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import {
  ensureBootedSimulator,
  markSimulatorBooted,
  shutdownSimulator,
  SIMULATOR_BOOTED_MEMO_TTL_MS,
} from '../simulator.ts';
import { runXcrun } from '../tool-provider.ts';

vi.mock('../tool-provider.ts', () => ({
  runAppleToolCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  runXcrun: vi.fn(),
}));

const mockRunXcrun = vi.mocked(runXcrun);

const simulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

function bootedListResult() {
  return {
    stdout: JSON.stringify({
      devices: { 'iOS 26.2': [{ udid: 'sim-1', state: 'Booted' }] },
    }),
    stderr: '',
    exitCode: 0,
  };
}

function countSimctlListCalls(): number {
  return mockRunXcrun.mock.calls.filter(([args]) => args.includes('list')).length;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000 });
  mockRunXcrun.mockReset();
  mockRunXcrun.mockImplementation(async () => bootedListResult());
});

afterEach(() => {
  vi.useRealTimers();
});

test('ensureBootedSimulator skips the state listing within the booted memo TTL', async () => {
  await ensureBootedSimulator(simulator);
  expect(countSimctlListCalls()).toBe(1);

  await ensureBootedSimulator(simulator);
  expect(countSimctlListCalls()).toBe(1);

  vi.advanceTimersByTime(SIMULATOR_BOOTED_MEMO_TTL_MS + 1);
  await ensureBootedSimulator(simulator);
  expect(countSimctlListCalls()).toBe(2);
});

test('shutdownSimulator invalidates the booted memo', async () => {
  await ensureBootedSimulator(simulator);
  expect(countSimctlListCalls()).toBe(1);

  await shutdownSimulator(simulator);

  await ensureBootedSimulator(simulator);
  expect(countSimctlListCalls()).toBe(2);
});

test('markSimulatorBooted seeds the memo so the first boot check skips the listing', async () => {
  markSimulatorBooted(simulator);

  await ensureBootedSimulator(simulator);
  expect(countSimctlListCalls()).toBe(0);
});

test('booted memo is scoped per simulator set path', async () => {
  await ensureBootedSimulator(simulator);
  expect(countSimctlListCalls()).toBe(1);

  await ensureBootedSimulator({ ...simulator, simulatorSetPath: '/custom/set' });
  expect(countSimctlListCalls()).toBe(2);
});

test.sequential('process memo test setup clears simulator boot memo: seed', async () => {
  markSimulatorBooted(simulator);

  await ensureBootedSimulator(simulator);

  expect(countSimctlListCalls()).toBe(0);
});

test.sequential('process memo test setup clears simulator boot memo: verify', async () => {
  await ensureBootedSimulator(simulator);

  expect(countSimctlListCalls()).toBe(1);
});
