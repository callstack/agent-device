import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createLaunchObservationProbe } from './snapshot-observability.ts';
import type { SnapshotSourceFailure, SnapshotSourceOutcome } from './snapshot-source-facade.ts';

const simulator = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;

const target = {
  udid: simulator.id,
  runtime: 'iOS 26.0',
  pid: 42,
  generation: '42:launch-a',
  targetId: `${simulator.id}:com.example.app`,
  processStartTime: 'Sat Sep  6 09:00:00 2026',
} as const;

const failed = (
  code: string,
  kind: SnapshotSourceFailure['kind'] = 'unsupported',
): SnapshotSourceOutcome => ({
  stage: 'failed',
  failure: { kind, code },
});
const acquired = (): SnapshotSourceOutcome => ({
  stage: 'acquired',
  acquisition: {
    producer: 'simulator-ax-bridge',
    intent: 'full',
    nodes: [],
    residue: [],
  } as unknown as Extract<SnapshotSourceOutcome, { stage: 'acquired' }>['acquisition'],
});

function probe(
  outcomes: readonly SnapshotSourceOutcome[],
  clock: { now(): number; sleep(ms: number): Promise<void> },
) {
  let index = 0;
  const acquire = vi.fn(async () => outcomes[Math.min(index++, outcomes.length - 1)]!);
  const sleep = vi.fn(clock.sleep);
  const observe = createLaunchObservationProbe({
    source: { acquire, close: async () => {} },
    resolveTarget: async () => target,
    clock: { now: clock.now, sleep },
  });
  return { observe, acquire, sleep };
}

test('a launched app is observable as soon as the bridge publishes it', async () => {
  const { observe, acquire, sleep } = probe([acquired()], { now: () => 0, sleep: async () => {} });
  await expect(observe.awaitObservable(simulator, 'com.example.app', signal())).resolves.toBe(
    'observable',
  );
  expect(acquire).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
});

test('a missing AX server is re-read inside its window until it registers', async () => {
  let now = 0;
  const { observe, acquire } = probe(
    [
      failed('application-server-unavailable', 'transport-failure'),
      failed('application-server-unavailable', 'transport-failure'),
      acquired(),
    ],
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  await expect(observe.awaitObservable(simulator, 'com.example.app', signal())).resolves.toBe(
    'observable',
  );
  expect(acquire).toHaveBeenCalledTimes(3);
});

test('an ownership miss after an AX-server miss shrinks the deadline to the ownership window', async () => {
  // AX-server window (5 s) opens at t=0; the ownership miss at t=2 s must end the wait by t=3 s,
  // not at t=5 s, so a launch-time system dialog reaches the typed fallback quickly.
  let now = 0;
  let sleeps = 0;
  const { observe, acquire } = probe(
    [
      failed('application-server-unavailable', 'transport-failure'),
      failed('foreground-owner-unverified'),
    ],
    {
      now: () => now,
      sleep: async (ms) => {
        // The first poll lands 2 s later (a slow host); every later poll takes what it asked for.
        sleeps += 1;
        now += sleeps === 1 ? 2_000 : ms;
      },
    },
  );
  await expect(observe.awaitObservable(simulator, 'com.example.app', signal())).resolves.toBe(
    'unobservable',
  );
  expect(now).toBeGreaterThanOrEqual(3_000);
  expect(now).toBeLessThanOrEqual(3_150);
  expect(acquire.mock.calls.length).toBeGreaterThan(2);
});

test('the last poll is capped to the remaining window', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const { observe } = probe([failed('foreground-owner-unverified')], {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  await observe.awaitObservable(simulator, 'com.example.app', signal());
  expect(Math.max(...sleeps)).toBeLessThanOrEqual(150);
  expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1_000);
});

test('a failure outside the launch transition ends the wait at once', async () => {
  const { observe, acquire, sleep } = probe(
    [failed('bridge-disconnected', 'transport-failure'), acquired()],
    { now: () => 0, sleep: async () => {} },
  );
  await expect(observe.awaitObservable(simulator, 'com.example.app', signal())).resolves.toBe(
    'unobservable',
  );
  expect(acquire).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
});

test('a device without a bridge is not eligible', async () => {
  const { observe, acquire } = probe([acquired()], { now: () => 0, sleep: async () => {} });
  await expect(
    observe.awaitObservable({ ...simulator, kind: 'device' }, 'com.example.app', signal()),
  ).resolves.toBe('not-eligible');
  expect(acquire).not.toHaveBeenCalled();
});

function signal(): AbortSignal {
  return new AbortController().signal;
}
