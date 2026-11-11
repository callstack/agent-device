import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertSupportedScreenshotPixelDensity,
  readScreenshotResultMetadata,
} from './screenshot-density.ts';
import { writeFile } from 'node:fs/promises';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';
import { PNG } from './png.ts';
import path from 'node:path';

type Device = Pick<DeviceInfo, 'platform' | 'appleOs' | 'kind'>;
const simulator: Device = { platform: 'apple', appleOs: 'ios', kind: 'simulator' };
const android: Device = { platform: 'android', kind: 'emulator' };

test('native density is accepted on iOS simulators', () => {
  assert.doesNotThrow(() => assertSupportedScreenshotPixelDensity(simulator, undefined, true));
});

test('native density and an explicit density are refused together', () => {
  assert.throws(
    () => assertSupportedScreenshotPixelDensity(simulator, 2, true),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('native density is refused where density is unsupported', () => {
  assert.throws(
    () => assertSupportedScreenshotPixelDensity(android, undefined, true),
    (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_OPERATION',
  );
});

test('a native capture reports its points, so a tap can be mapped from its pixels', async () => {
  const dir = await mkdtempForTest('density-');
  const file = path.join(dir, 'shot.png');
  await writeFile(file, PNG.sync.write(new PNG({ width: 126, height: 273 })));
  assert.deepEqual(
    await readScreenshotResultMetadata({
      device: simulator,
      path: file,
      requestedPixelDensity: undefined,
      nativeDensity: true,
      sourcePixelDensity: 3,
      scale: undefined,
    }),
    { width: 126, height: 273, logicalWidth: 42, logicalHeight: 91, pixelDensity: 3 },
  );
});
