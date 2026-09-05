import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { areIosSnapshotComparisonIdentitiesEqual } from '@agent-device/capture-kit/ios-snapshot-planning';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import { createAppleSnapshotRoute } from './snapshot-route.ts';
import type { SimulatorSnapshotSource, SnapshotSourceOutcome } from './snapshot-source-facade.ts';

const ios = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-1',
  name: 'iPhone',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;

const target = {
  udid: ios.id,
  runtime: 'iOS 26.0',
  pid: 42,
  generation: '42:launch-a',
  targetId: `${ios.id}:com.example.app`,
  processStartTime: 'target-start',
} as const;

const input = { options: { appBundleId: 'com.example.app' } } as const;

test('eligible simulator capture publishes bridge acquisition without touching XCTest', async () => {
  const acquired = bridgeAcquisition();
  const source = sourceReturning(acquired);
  const presentIosAcquisition = vi.fn(async () => ({
    backend: 'xctest' as const,
    producer: 'simulator-ax-bridge' as const,
    nodes: [{ index: 0, type: 'Application' }],
  }));
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(
    {
      ...platformRuntimeHostFixture(),
      snapshot: { captureSurface: vi.fn(), presentIosAcquisition },
    },
    { source, resolveTarget: vi.fn(async () => target) },
  );

  await expect(route.capture(ios, input, signal(), fallback)).resolves.toMatchObject({
    producer: 'simulator-ax-bridge',
  });
  expect(presentIosAcquisition).toHaveBeenCalledWith(acquired, input.options);
  expect(fallback).not.toHaveBeenCalled();
});

test('typed bridge failure falls back once and disables retries for that app generation', async () => {
  const source = sourceReturning({
    stage: 'failed',
    failure: { kind: 'transport-failure', code: 'bridge-disconnected' },
  });
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    resolveTarget: vi.fn(async () => target),
  });

  const first = await route.capture(ios, input, signal(), fallback);
  const second = await route.capture(ios, input, signal(), fallback);

  expect(source.acquire).toHaveBeenCalledOnce();
  expect(fallback).toHaveBeenCalledTimes(2);
  expect(first.warnings).toEqual([
    'Simulator AX snapshot unavailable (bridge-disconnected); used XCTest for this app generation.',
  ]);
  expect(first.comparisonIdentity).toMatchObject({
    producer: 'apple-runner',
    lineage: { generation: target.generation },
    residue: [{ kind: 'fallback-source', producer: 'apple-runner' }],
  });
  expect(second.comparisonIdentity).toMatchObject({
    producer: 'apple-runner',
    lineage: { generation: target.generation },
  });
});

test('a new app generation re-enables the bridge', async () => {
  const source = sourceReturning({
    stage: 'failed',
    failure: { kind: 'transport-failure', code: 'bridge-disconnected' },
  });
  const resolveTarget = vi
    .fn()
    .mockResolvedValueOnce(target)
    .mockResolvedValueOnce(target)
    .mockResolvedValueOnce({ ...target, pid: 84, generation: '84:launch-b' });
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    resolveTarget,
  });

  await route.capture(ios, input, signal(), fallback);
  await route.capture(ios, input, signal(), fallback);
  await route.capture(ios, input, signal(), fallback);

  expect(source.acquire).toHaveBeenCalledTimes(2);
});

test('stale bridge acquisition resolves the current generation before XCTest fallback', async () => {
  const currentTarget = { ...target, pid: 84, generation: '84:launch-b' };
  const source = sourceReturning({
    stage: 'failed',
    failure: { kind: 'stale-target', code: 'target-generation-changed' },
  });
  const resolveTarget = vi.fn().mockResolvedValueOnce(target).mockResolvedValueOnce(currentTarget);
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    resolveTarget,
  });

  const result = await route.capture(ios, input, signal(), async () => runnerResult());

  expect(resolveTarget).toHaveBeenCalledTimes(2);
  expect(resolveTarget).toHaveBeenLastCalledWith(
    ios,
    input.options.appBundleId,
    expect.any(AbortSignal),
    'refresh',
  );
  expect(result.comparisonIdentity?.lineage).toEqual({
    targetId: currentTarget.targetId,
    generation: currentTarget.generation,
  });
});

test('target-resolution fallback remains incomparable with a bridge publication', async () => {
  const source = sourceReturning(bridgeAcquisition());
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    resolveTarget: vi.fn(async () => {
      throw new Error('launch job unavailable');
    }),
  });

  const result = await route.capture(ios, input, signal(), fallback);

  expect(source.acquire).not.toHaveBeenCalled();
  expect(result.comparisonIdentity).toMatchObject({
    producer: 'apple-runner',
    lineage: { targetId: target.targetId },
    residue: [
      { kind: 'unknown-generation', captureId: expect.any(String) },
      { kind: 'fallback-source', producer: 'apple-runner' },
    ],
  });
});

test('two target-resolution fallbacks cannot share comparison identity', async () => {
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source: sourceReturning(bridgeAcquisition()),
    resolveTarget: vi.fn(async () => {
      throw new Error('launch job unavailable');
    }),
  });

  const first = await route.capture(ios, input, signal(), async () => runnerResult());
  const second = await route.capture(ios, input, signal(), async () => runnerResult());

  expect(first.comparisonIdentity).toBeDefined();
  expect(second.comparisonIdentity).toBeDefined();
  expect(
    areIosSnapshotComparisonIdentitiesEqual(first.comparisonIdentity!, second.comparisonIdentity!),
  ).toBe(false);
});

test('runtime shutdown closes the process-owned bridge source', async () => {
  const source = sourceReturning(bridgeAcquisition());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), { source });

  await route.shutdown();

  expect(source.close).toHaveBeenCalledOnce();
});

test('cancelled acquisition does not start a fallback after the request aborts', async () => {
  const controller = new AbortController();
  const source = sourceReturning({
    stage: 'failed',
    failure: { kind: 'cancelled', code: 'abort-signal' },
  });
  vi.mocked(source.acquire).mockImplementation(async () => {
    controller.abort(new DOMException('request ended', 'AbortError'));
    return { stage: 'failed', failure: { kind: 'cancelled', code: 'abort-signal' } };
  });
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(platformRuntimeHostFixture(), {
    source,
    resolveTarget: vi.fn(async () => target),
  });

  await expect(route.capture(ios, input, controller.signal, fallback)).rejects.toThrow(
    'request ended',
  );
  expect(fallback).not.toHaveBeenCalled();
});

function bridgeAcquisition(): Extract<SnapshotSourceOutcome, { stage: 'acquired' }> {
  return {
    stage: 'acquired',
    acquisition: {
      producer: 'simulator-ax-bridge',
      intent: 'full',
      hint: {
        projection: 'regular',
        rawTraversalDepth: null,
        regularPresentedDepth: null,
        interactiveOnly: false,
        customActions: false,
        acquisitionIntent: 'full',
      },
      nodes: [{ index: 0, type: 'Application' }],
      truncated: false,
      viewport: { kind: 'reported', rect: { x: 0, y: 0, width: 100, height: 200 } },
      lineage: { targetId: target.targetId, generation: target.generation },
      residue: [],
    },
  };
}

function sourceReturning(
  outcome: Awaited<ReturnType<SimulatorSnapshotSource['acquire']>>,
): SimulatorSnapshotSource {
  return { acquire: vi.fn(async () => outcome), close: vi.fn(async () => {}) };
}

function runnerResult() {
  return { backend: 'xctest' as const, producer: 'apple-runner' as const, nodes: [] };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

const OWNER_UNVERIFIED = {
  stage: 'failed',
  failure: { kind: 'unsupported', code: 'foreground-owner-unverified' },
} as const satisfies SnapshotSourceOutcome;

function lstart(msAgo: number, nowMs: number): string {
  return new Date(nowMs - msAgo).toString().replace(/ GMT.*$/, '');
}

function launchGraceRoute(
  outcomes: readonly SnapshotSourceOutcome[],
  processStartTime: string,
  clock: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> },
) {
  const acquire = vi.fn(
    async () => outcomes[Math.min(acquire.mock.calls.length - 1, outcomes.length - 1)]!,
  );
  const presentIosAcquisition = vi.fn(async () => ({
    backend: 'xctest' as const,
    producer: 'simulator-ax-bridge' as const,
    nodes: [{ index: 0, type: 'Application' }],
  }));
  const fallback = vi.fn(async () => runnerResult());
  const route = createAppleSnapshotRoute(
    {
      ...platformRuntimeHostFixture(),
      clock,
      snapshot: { captureSurface: vi.fn(), presentIosAcquisition },
    },
    {
      source: { acquire, close: vi.fn(async () => {}) },
      resolveTarget: vi.fn(async () => ({ ...target, processStartTime })),
    },
  );
  return { route, acquire, fallback, presentIosAcquisition };
}

test('a foreground-owner miss on a just-launched target is re-read inside the launch grace', async () => {
  const nowMs = Date.parse('2026-09-06T00:00:10.000Z');
  const sleep = vi.fn(async () => {});
  const { route, acquire, fallback } = launchGraceRoute(
    [OWNER_UNVERIFIED, bridgeAcquisition()],
    lstart(800, nowMs),
    { now: () => nowMs, sleep },
  );

  await expect(route.capture(ios, input, signal(), fallback)).resolves.toMatchObject({
    producer: 'simulator-ax-bridge',
  });
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledOnce();
  expect(fallback).not.toHaveBeenCalled();
});

test('an unregistered AX server on a just-launched target is re-read inside the launch grace', async () => {
  const nowMs = Date.parse('2026-09-06T00:00:10.000Z');
  const { route, acquire, fallback } = launchGraceRoute(
    [
      {
        stage: 'failed',
        failure: { kind: 'transport-failure', code: 'application-server-unavailable' },
      },
      bridgeAcquisition(),
    ],
    lstart(1_200, nowMs),
    { now: () => nowMs, sleep: async () => {} },
  );

  await expect(route.capture(ios, input, signal(), fallback)).resolves.toMatchObject({
    producer: 'simulator-ax-bridge',
  });
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(fallback).not.toHaveBeenCalled();
});

test('a bridge transport loss on a just-launched target is not a launch transition', async () => {
  const nowMs = Date.parse('2026-09-06T00:00:10.000Z');
  const { route, acquire, fallback } = launchGraceRoute(
    [{ stage: 'failed', failure: { kind: 'transport-failure', code: 'bridge-disconnected' } }],
    lstart(500, nowMs),
    { now: () => nowMs, sleep: async () => {} },
  );

  await route.capture(ios, input, signal(), fallback);
  expect(acquire).toHaveBeenCalledOnce();
  expect(fallback).toHaveBeenCalledOnce();
});

test('a foreground-owner miss on an established target falls back at once', async () => {
  const nowMs = Date.parse('2026-09-06T00:00:10.000Z');
  const sleep = vi.fn(async () => {});
  const { route, acquire, fallback } = launchGraceRoute(
    [OWNER_UNVERIFIED, bridgeAcquisition()],
    lstart(60_000, nowMs),
    { now: () => nowMs, sleep },
  );

  await expect(route.capture(ios, input, signal(), fallback)).resolves.toMatchObject({
    warnings: [expect.stringContaining('foreground-owner-unverified')],
  });
  expect(acquire).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
  expect(fallback).toHaveBeenCalledOnce();
});

test('the ownership grace is one second from the first miss, then the typed fallback applies', async () => {
  let nowMs = Date.parse('2026-09-06T00:00:10.000Z');
  const startedAt = lstart(4_000, nowMs);
  const sleep = vi.fn(async () => {
    nowMs += 400;
  });
  const { route, acquire, fallback } = launchGraceRoute([OWNER_UNVERIFIED], startedAt, {
    now: () => nowMs,
    sleep,
  });

  await expect(route.capture(ios, input, signal(), fallback)).resolves.toMatchObject({
    warnings: [expect.stringContaining('foreground-owner-unverified')],
  });
  expect(acquire.mock.calls.length).toBeGreaterThan(1);
  expect(acquire.mock.calls.length).toBeLessThanOrEqual(4);
  expect(fallback).toHaveBeenCalledOnce();
});

test('the AX-server grace outlives the bridge cold start that consumed the launch', async () => {
  // First failure observed 6 s after the process appeared (a cold bridge start), still young.
  let nowMs = Date.parse('2026-09-06T00:00:10.000Z');
  const startedAt = lstart(6_000, nowMs);
  const sleep = vi.fn(async () => {
    nowMs += 500;
  });
  const { route, acquire, fallback } = launchGraceRoute(
    [
      {
        stage: 'failed',
        failure: { kind: 'transport-failure', code: 'application-server-unavailable' },
      },
      {
        stage: 'failed',
        failure: { kind: 'transport-failure', code: 'application-server-unavailable' },
      },
      {
        stage: 'failed',
        failure: { kind: 'transport-failure', code: 'application-server-unavailable' },
      },
      bridgeAcquisition(),
    ],
    startedAt,
    { now: () => nowMs, sleep },
  );

  await expect(route.capture(ios, input, signal(), fallback)).resolves.toMatchObject({
    producer: 'simulator-ax-bridge',
  });
  expect(acquire).toHaveBeenCalledTimes(4);
  expect(fallback).not.toHaveBeenCalled();
});
