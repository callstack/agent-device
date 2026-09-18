import { expect, test, vi } from 'vitest';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createLaunchObservationProbe } from './snapshot-observability.ts';
import type { SnapshotSourceFailure, SnapshotSourceOutcome } from './snapshot-source-facade.ts';
import type { SimulatorSnapshotTarget } from './snapshot-target.ts';

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
  isBridgeDisabled: (probed: SimulatorSnapshotTarget) => boolean = () => false,
) {
  let index = 0;
  const acquire = vi.fn(async () => outcomes[Math.min(index++, outcomes.length - 1)]!);
  const sleep = vi.fn(clock.sleep);
  const gate = vi.fn(isBridgeDisabled);
  const observe = createLaunchObservationProbe({
    source: { acquire, close: async () => {} },
    resolveTarget: async () => target,
    clock: { now: clock.now, sleep },
    isBridgeDisabled: gate,
  });
  return { observe, acquire, sleep, gate };
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

test.each(['bridge-disconnected', 'continuation-budget-exhausted', 'snapshot-tree-malformed'])(
  'a %s failure ends the launch wait at once',
  async (code) => {
    const { observe, acquire, sleep } = probe([failed(code, 'transport-failure'), acquired()], {
      now: () => 0,
      sleep: async () => {},
    });
    await expect(observe.awaitObservable(simulator, 'com.example.app', signal())).resolves.toBe(
      'unobservable',
    );
    expect(acquire).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  },
);

test('a generation whose bridge circuit is open is unobservable without a bridge round trip', async () => {
  const { observe, acquire, sleep, gate } = probe(
    [acquired()],
    { now: () => 0, sleep: async () => {} },
    () => true,
  );
  await expect(observe.awaitObservable(simulator, 'com.example.app', signal())).resolves.toBe(
    'unobservable',
  );
  expect(gate).toHaveBeenCalledWith(target);
  expect(acquire).not.toHaveBeenCalled();
  expect(sleep).not.toHaveBeenCalled();
});

test('the skip is reported, so a live run can tell it from an unresolvable target', async () => {
  // Both verdicts are `unobservable` with zero acquisitions; only the diagnostic separates a
  // circuit skip from a target that never resolved.
  await withDiagnosticsScope({ command: 'open' }, async () => {
    const skipped = probe([acquired()], { now: () => 0, sleep: async () => {} }, () => true);
    await skipped.observe.awaitObservable(simulator, 'com.example.app', signal());
    expect(countDiagnosticEventsByPhase(['ios_launch_observation_skipped'])).toBe(1);
  });
  await withDiagnosticsScope({ command: 'open' }, async () => {
    const unresolvable = createLaunchObservationProbe({
      source: { acquire: vi.fn(), close: async () => {} },
      resolveTarget: async () => {
        throw new Error('no target');
      },
      clock: { now: () => 0, sleep: async () => {} },
      isBridgeDisabled: () => true,
    });
    await expect(
      unresolvable.awaitObservable(simulator, 'com.example.app', signal()),
    ).resolves.toBe('unobservable');
    expect(countDiagnosticEventsByPhase(['ios_launch_observation_skipped'])).toBe(0);
  });
});

test.each([
  ['a physical iOS device', { ...simulator, kind: 'device' as const }],
  ['a tvOS Simulator', { ...simulator, appleOs: 'tvos' as const, target: 'tv' as const }],
])('%s has no bridge and is not eligible', async (_name, device) => {
  const { observe, acquire, gate } = probe([acquired()], { now: () => 0, sleep: async () => {} });
  await expect(observe.awaitObservable(device, 'com.example.app', signal())).resolves.toBe(
    'not-eligible',
  );
  expect(acquire).not.toHaveBeenCalled();
  expect(gate).not.toHaveBeenCalled();
});

function signal(): AbortSignal {
  return new AbortController().signal;
}
