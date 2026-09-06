import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { areIosSnapshotComparisonIdentitiesEqual } from '@agent-device/capture-kit/ios-snapshot-planning';
import { createLocalAppleToolProvider, withAppleToolProvider } from './core/tool-provider.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import { createAppleSnapshotRoute } from './snapshot-route.ts';
import { createSimulatorSnapshotTargetResolver } from './snapshot-target.ts';
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

test('a slow app discovery yields to the XCTest fallback within its wait slice, then serves the bridge', async () => {
  // The production resolver over a simctl whose `launchctl list` answers only when released,
  // the shape of a loaded CI host: the first capture must not sit on that probe.
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'spawn') await released;
    return {
      stdout:
        args[0] === 'spawn'
          ? `42\t0\tUIKitApplication:${input.options.appBundleId}[launch-a][rb-legacy]`
          : JSON.stringify({
              devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: ios.id }] },
            }),
      stderr: '',
      exitCode: 0,
    };
  });
  const runCommand = vi.fn(async () => ({ stdout: 'start-a', stderr: '', exitCode: 0 }));
  const fallback = vi.fn(async () => runnerResult());
  const source = sourceReturning(bridgeAcquisition());
  const presentIosAcquisition = vi.fn(async () => ({
    backend: 'xctest' as const,
    producer: 'simulator-ax-bridge' as const,
    nodes: [{ index: 0, type: 'Application' }],
  }));
  const route = createAppleSnapshotRoute(
    {
      ...platformRuntimeHostFixture(),
      snapshot: { captureSurface: vi.fn(), presentIosAcquisition },
    },
    { source, resolveTarget: createSimulatorSnapshotTargetResolver() },
  );
  vi.useFakeTimers();
  try {
    await withAppleToolProvider(
      createLocalAppleToolProvider({ simctl: { run }, runCommand }),
      async () => {
        const first = route.capture(ios, input, signal(), fallback);
        await vi.advanceTimersByTimeAsync(1_500);
        const result = await first;
        expect(fallback).toHaveBeenCalledOnce();
        expect(result.warnings).toEqual([
          'Simulator AX snapshot unavailable (target-resolution-failed); used XCTest for an unverified app generation.',
        ]);
        expect(source.acquire).not.toHaveBeenCalled();

        release();
        await vi.advanceTimersByTimeAsync(0);
        const second = await route.capture(ios, input, signal(), fallback);
        expect(second.producer).toBe('simulator-ax-bridge');
        expect(fallback).toHaveBeenCalledOnce();
        expect(run.mock.calls.filter(([args]) => args[0] === 'spawn')).toHaveLength(1);
      },
    );
  } finally {
    vi.useRealTimers();
  }
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
