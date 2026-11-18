import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { mkdtempForTestSync } from '@agent-device/test-kit';

import type { LiveContext } from './live-harness.ts';
import { type SurfaceCapture, waitForSurfaceChange } from './live-surface-transition.ts';

const CONTEXT = {} as LiveContext;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FIXTURE_SURFACE = Buffer.concat([PNG_SIGNATURE, Buffer.from('fixture-foreground')]);
const HOME_SURFACE = Buffer.concat([PNG_SIGNATURE, Buffer.from('home-surface')]);

let artifactDir: string;
let baselinePath: string;
let outputPath: string;

beforeEach(() => {
  vi.useFakeTimers();
  artifactDir = mkdtempForTestSync('surface-transition-');
  baselinePath = path.join(artifactDir, 'baseline.png');
  outputPath = path.join(artifactDir, 'observed.png');
  fs.writeFileSync(baselinePath, FIXTURE_SURFACE);
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const settled = Promise.allSettled([promise]).then(([result]) => result);
  await vi.runAllTimersAsync();
  return settled;
}

/** A capture script: entry `attempt - 1` is written, the last entry repeats; an Error is thrown. */
function scriptedCapture(script: (Buffer | Error)[]): {
  capture: SurfaceCapture;
  attempts: () => number;
} {
  let attempts = 0;
  const capture: SurfaceCapture = async (output, attempt) => {
    attempts = attempt;
    const image = script[Math.min(attempt - 1, script.length - 1)]!;
    if (image instanceof Error) throw image;
    fs.writeFileSync(output, image);
  };
  return { attempts: () => attempts, capture };
}

test('a delayed transition satisfies the wait only after a capture differs, keeping that final image', async () => {
  const { attempts, capture } = scriptedCapture([FIXTURE_SURFACE, FIXTURE_SURFACE, HOME_SURFACE]);
  const result = await settle(
    waitForSurfaceChange(
      CONTEXT,
      baselinePath,
      outputPath,
      'capture surface',
      'surface never changed',
      capture,
    ),
  );

  expect(result.status).toBe('fulfilled');
  expect(attempts()).toBe(3);
  expect(fs.readFileSync(outputPath).equals(HOME_SURFACE)).toBe(true);
});

test('a capture that fails transiently is retried until the surface changes', async () => {
  const { attempts, capture } = scriptedCapture([
    new Error('screenshot: device offline'),
    FIXTURE_SURFACE,
    HOME_SURFACE,
  ]);
  const result = await settle(
    waitForSurfaceChange(
      CONTEXT,
      baselinePath,
      outputPath,
      'capture surface',
      'surface never changed',
      capture,
    ),
  );

  expect(result.status).toBe('fulfilled');
  expect(attempts()).toBe(3);
  expect(fs.readFileSync(outputPath).equals(HOME_SURFACE)).toBe(true);
});

test('a surface that never changes fails at the deadline and keeps the last observed image', async () => {
  const { attempts, capture } = scriptedCapture([FIXTURE_SURFACE]);
  const result = await settle(
    waitForSurfaceChange(
      CONTEXT,
      baselinePath,
      outputPath,
      'capture surface',
      'surface never changed',
      capture,
    ),
  );

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /surface never changed within 10000ms.*capture \d+ still matched/s,
      ),
    },
  });
  expect(attempts()).toBe(40);
  expect(fs.readFileSync(outputPath).equals(FIXTURE_SURFACE)).toBe(true);
});

test('a wait whose captures keep failing reports the last capture error at the deadline', async () => {
  const { capture } = scriptedCapture([new Error('screenshot: device offline')]);
  const result = await settle(
    waitForSurfaceChange(
      CONTEXT,
      baselinePath,
      outputPath,
      'capture surface',
      'surface never changed',
      capture,
    ),
  );

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(/surface never changed within 10000ms.*device offline/s),
    },
  });
});
