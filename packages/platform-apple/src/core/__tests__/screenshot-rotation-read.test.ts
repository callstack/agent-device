import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bindTestCommandHost } from '@agent-device/test-kit';
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

test('a known single-panel capture reports no rotation when its read misses the grace', async () => {
  let probeSignal: AbortSignal | undefined;
  const facts = await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/s.png', {
    env: process.env,
    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted: async () => {},
      normalizeDensity: async () => {},
      isKnownSinglePanel: () => true,
      resolveCaptureTarget: async (_device, options) => {
        probeSignal = options?.signal;
        return await new Promise<never>(() => {});
      },
      captureWithRetry: async () => {},
    },
  });
  assert.deepEqual(facts, {});
  assert.equal(probeSignal?.aborted, true, 'the late read is aborted');
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
