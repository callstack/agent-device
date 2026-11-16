import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { bindTestCommandHost } from '@agent-device/test-kit';

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn() };
});

import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';
import { captureSimulatorScreenshotWithFallback } from '../screenshot.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

bindTestCommandHost();

test('a known single-panel capture reads its rotation beside the image', async () => {
  const events: string[] = [];
  let finishProbe!: () => void;
  const facts = await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/s.png', {
    env: process.env,
    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted: async () => {},
      normalizeDensity: async () => {},
      isKnownSinglePanel: () => true,
      resolveCaptureTarget: async () => {
        events.push('probe-start');
        await new Promise<void>((resolve) => {
          finishProbe = resolve;
        });
        events.push('probe-end');
        return { displayRotation: 'landscape-left' };
      },
      captureWithRetry: async (_device, _outPath, _mask, display) => {
        assert.equal(display, undefined);
        events.push('capture');
        finishProbe();
      },
    },
  });
  assert.deepEqual(events, ['probe-start', 'capture', 'probe-end']);
  assert.deepEqual(facts, { displayRotation: 'landscape-left' });
});

test('a known single-panel read gets a 2 s budget and 250 ms after the image, then is aborted', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let probeOptions: { timeoutMs?: number; signal?: AbortSignal } | undefined;
    let captured = false;
    let facts: object | undefined;
    const capture = captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/s.png', {
      env: process.env,
      skipIosSimulatorBootCheck: true,
      deps: {
        ensureBooted: async () => {},
        normalizeDensity: async () => {},
        isKnownSinglePanel: () => true,
        resolveCaptureTarget: async (_device, options) => {
          probeOptions = options;
          return await new Promise<never>(() => {});
        },
        captureWithRetry: async () => {
          captured = true;
        },
      },
    });
    void capture.then((result) => {
      facts = result;
    });

    await vi.advanceTimersByTimeAsync(249);
    assert.equal(captured, true);
    assert.equal(probeOptions?.timeoutMs, 2_000);
    assert.equal(facts, undefined, 'the capture waits out the grace');
    assert.equal(probeOptions?.signal?.aborted, false);

    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(facts, {}, 'the capture reports no rotation once the grace ends');
    assert.equal(probeOptions?.signal?.aborted, true, 'the late read is aborted');
  } finally {
    // A failed assertion must not leave the capture holding the simulator's status bar lock.
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  }
});

test('a known single-panel read waits out its grace after the status bar is released', async () => {
  const events: string[] = [];
  let finishProbe!: () => void;
  const facts = await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/s.png', {
    env: process.env,
    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted: async () => {},
      normalizeDensity: async () => {},
      isKnownSinglePanel: () => true,
      withStatusBarHeld: async (_device, capture) => {
        const result = await capture();
        events.push('released');
        // The read answers only once the bar is free, so a grace inside the hold would miss it.
        finishProbe();
        return result;
      },
      resolveCaptureTarget: async () => {
        await new Promise<void>((resolve) => {
          finishProbe = resolve;
        });
        events.push('read');
        return { displayRotation: 'landscape-right' };
      },
      captureWithRetry: async () => {
        events.push('capture');
      },
    },
  });
  assert.deepEqual(events, ['capture', 'released', 'read']);
  assert.deepEqual(facts, { displayRotation: 'landscape-right' });
});

test('a known single-panel capture reports no rotation when its read fails', async () => {
  const facts = await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/s.png', {
    env: process.env,
    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted: async () => {},
      normalizeDensity: async () => {},
      isKnownSinglePanel: () => true,
      resolveCaptureTarget: async () => {
        throw new Error('devicectl failed');
      },
      captureWithRetry: async () => {},
    },
  });
  assert.deepEqual(facts, {});
});

test('a device not known to be single-panel reads its panel table before the capture', async () => {
  const events: string[] = [];
  const panel = {
    name: 'LCD-1',
    displayId: 3,
    power: 'lit',
    primary: false,
    widthPx: 2007,
    heightPx: 2853,
    pointScale: 3,
    currentOrientation: 'rot90',
    integrated: true,
  } as const;
  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/s.png', {
    env: process.env,
    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted: async () => {},
      normalizeDensity: async () => {},
      isKnownSinglePanel: () => false,
      resolveCaptureTarget: async () => {
        events.push('probe');
        return { display: panel };
      },
      captureWithRetry: async (_device, _outPath, _mask, display) => {
        events.push(`capture ${display?.name}`);
      },
    },
  });
  assert.deepEqual(events, ['probe', 'capture LCD-1']);
});

test('a read beside the capture that names a panel reports the stale single-panel count', async () => {
  const panel = {
    name: 'LCD',
    displayId: 1,
    power: 'lit',
    primary: true,
    widthPx: 1398,
    heightPx: 2034,
    pointScale: 3,
    currentOrientation: 'rot0',
    integrated: true,
  } as const;
  const facts = await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/s.png', {
    env: process.env,
    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted: async () => {},
      normalizeDensity: async () => {},
      isKnownSinglePanel: () => true,
      resolveCaptureTarget: async () => ({ display: panel }),
      captureWithRetry: async () => {},
    },
  });
  assert.deepEqual(facts, {});
  assert.ok(
    vi
      .mocked(emitDiagnostic)
      .mock.calls.some(([event]) => event.phase === 'apple_display_single_panel_count_stale'),
  );
});

test('a read beside the capture that refuses an unidentified panel reports the stale count', async () => {
  vi.mocked(emitDiagnostic).mockClear();
  const captureStale = async (error: Error) => {
    vi.mocked(emitDiagnostic).mockClear();
    const facts = await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/s.png', {
      env: process.env,
      skipIosSimulatorBootCheck: true,
      deps: {
        ensureBooted: async () => {},
        normalizeDensity: async () => {},
        isKnownSinglePanel: () => true,
        resolveCaptureTarget: async () => {
          throw error;
        },
        captureWithRetry: async () => {},
      },
    });
    assert.deepEqual(facts, {});
    return vi
      .mocked(emitDiagnostic)
      .mock.calls.some(([event]) => event.phase === 'apple_display_single_panel_count_stale');
  };

  assert.equal(
    await captureStale(
      new AppError('COMMAND_FAILED', 'which panel?', { reason: 'capture-panel-unidentified' }),
    ),
    true,
  );
  // Only the typed refusal says the table listed several panels; other failures say nothing.
  assert.equal(
    await captureStale(new AppError('COMMAND_FAILED', 'capture-panel-unidentified')),
    false,
  );
  assert.equal(await captureStale(new Error('devicectl failed')), false);
});
