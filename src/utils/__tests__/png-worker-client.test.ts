import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '../../kernel/errors.ts';
import { PNG } from '../png-codec.ts';
import {
  computeScreenshotDiffPixelsAsync,
  decodePngAsync,
  encodePngAsync,
  terminatePngWorker,
} from '../png-worker-client.ts';
import { computeScreenshotDiffPixels } from '../screenshot-diff-pixels.ts';

afterAll(async () => {
  await terminatePngWorker();
});

/** Build a small PNG with a deterministic gradient pattern. */
function buildPatternPng(width: number, height: number, seed: number): PNG {
  const png = new PNG({ width, height });
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    png.data[index] = (pixel * 7 + seed) % 256;
    png.data[index + 1] = (pixel * 13 + seed * 3) % 256;
    png.data[index + 2] = (pixel * 29 + seed * 5) % 256;
    png.data[index + 3] = 255;
  }
  return png;
}

test('decodePngAsync matches the synchronous decoder byte for byte', async () => {
  const encoded = PNG.sync.write(buildPatternPng(13, 9, 1));

  const fromWorker = await decodePngAsync(encoded, 'fixture');
  const fromSync = PNG.sync.read(encoded);

  assert.equal(fromWorker.width, fromSync.width);
  assert.equal(fromWorker.height, fromSync.height);
  assert.deepEqual(fromWorker.data, fromSync.data);
});

test('encodePngAsync matches the synchronous encoder byte for byte', async () => {
  const png = buildPatternPng(13, 9, 2);

  const fromWorker = await encodePngAsync(png);
  const fromSync = PNG.sync.write(png);

  assert.deepEqual(fromWorker, fromSync);
});

test('computeScreenshotDiffPixelsAsync matches the synchronous diff', async () => {
  const baseline = buildPatternPng(13, 9, 3);
  const current = buildPatternPng(13, 9, 3);
  // Change a small block so the diff has both matching and differing pixels.
  for (let pixel = 20; pixel < 28; pixel += 1) {
    current.data[pixel * 4] = 255;
    current.data[pixel * 4 + 1] = 0;
    current.data[pixel * 4 + 2] = 0;
  }
  const job = {
    width: baseline.width,
    height: baseline.height,
    baselineData: baseline.data,
    currentData: current.data,
    maxColorDistance: 0.1 * 255 * Math.sqrt(3),
  };

  const fromWorker = await computeScreenshotDiffPixelsAsync(job);
  const fromSync = computeScreenshotDiffPixels(job);

  assert.equal(fromWorker.differentPixels, fromSync.differentPixels);
  assert.deepEqual(fromWorker.diffMask, fromSync.diffMask);
  assert.deepEqual(fromWorker.diffData, fromSync.diffData);
});

test('decodePngAsync rejects invalid PNG data with the canonical decode AppError', async () => {
  await assert.rejects(
    () => decodePngAsync(Buffer.from('not a png'), 'fixture'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.message, /Failed to decode fixture as PNG/);
      assert.equal(error.details?.label, 'fixture');
      assert.match(String(error.details?.reason), /Invalid PNG signature/);
      return true;
    },
  );
});
