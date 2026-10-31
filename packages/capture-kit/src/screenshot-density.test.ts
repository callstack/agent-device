import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { assertSupportedScreenshotPixelDensity, readScreenshotResultMetadata } from './screenshot-density.ts';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'density-'));
  const file = path.join(dir, 'shot.png');
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(1206, 16);
  png.writeUInt32BE(2622, 20);
  await writeFile(file, png);
  assert.deepEqual(
    await readScreenshotResultMetadata({
      device: simulator,
      path: file,
      requestedPixelDensity: undefined,
      nativeDensity: true,
      sourcePixelDensity: 3,
      scale: undefined,
    }),
    { width: 1206, height: 2622, logicalWidth: 402, logicalHeight: 874, pixelDensity: 3 },
  );
});
