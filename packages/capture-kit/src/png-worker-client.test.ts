import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { PNG } from './png.ts';
import {
  computePngRgbDifferenceAsync,
  computeScreenshotDiffPixelsAsync,
  cropPngBytesAsync,
  decodePngAsync,
  decodeScreenshotImageAsync,
  encodePngAsync,
  retainPngWorker,
  terminatePngWorker,
} from './png-worker-client.ts';
import { cropPngBytes } from './png-crop-bytes.ts';
import { computeScreenshotDiffPixels } from './screenshot-diff-pixels.ts';

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

/**
 * Runs one job and proves it reached the worker thread. While a job is pending the client
 * `ref()`s the worker, which holds a MessagePort resource on this event loop; the in-process
 * synchronous fallback the client takes silently when the worker cannot start holds none.
 */
async function runOnWorkerThread<T>(label: string, start: () => Promise<T>): Promise<T> {
  const pending = start();
  const resources = process.getActiveResourcesInfo();
  assert.ok(
    resources.includes('MessagePort'),
    `${label} did not run on the PNG worker thread (event-loop resources: ${resources.join(', ')})`,
  );
  return await pending;
}

test('decodePngAsync matches the synchronous decoder byte for byte', async () => {
  const encoded = PNG.sync.write(buildPatternPng(13, 9, 1));

  const fromWorker = await runOnWorkerThread('decode', () => decodePngAsync(encoded, 'fixture'));
  const fromSync = PNG.sync.read(encoded);

  assert.equal(fromWorker.width, fromSync.width);
  assert.equal(fromWorker.height, fromSync.height);
  assert.deepEqual(fromWorker.data, fromSync.data);
});

test('encodePngAsync preserves dimensions and every RGBA channel', async () => {
  const png = buildPatternPng(13, 9, 2);
  for (let pixel = 0; pixel < png.width * png.height; pixel += 1) {
    png.data[pixel * 4 + 3] = pixel % 256;
  }

  const fromWorker = await runOnWorkerThread('encode', () => encodePngAsync(png));
  const decoded = PNG.sync.read(fromWorker);

  assert.equal(decoded.width, png.width);
  assert.equal(decoded.height, png.height);
  assert.deepEqual(decoded.data, png.data);
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

  const fromWorker = await runOnWorkerThread('diff-pixels', () =>
    computeScreenshotDiffPixelsAsync(job),
  );
  const fromSync = computeScreenshotDiffPixels(job);

  assert.equal(fromWorker.differentPixels, fromSync.differentPixels);
  assert.ok(fromWorker.differentPixels > 0);
  assert.deepEqual(fromWorker.diffMask, fromSync.diffMask);
  assert.deepEqual(fromWorker.diffData, fromSync.diffData);
});

test('computePngRgbDifferenceAsync preserves the normalized absolute RGB metric', async () => {
  const black = new PNG({ width: 1, height: 1 });
  black.data.set([0, 0, 0, 255]);
  const white = new PNG({ width: 1, height: 1 });
  white.data.set([255, 255, 255, 255]);

  const result = await runOnWorkerThread('rgb-difference', () =>
    computePngRgbDifferenceAsync(PNG.sync.write(black), PNG.sync.write(white), 'fixture'),
  );

  assert.deepEqual(result, {
    status: 'compared',
    differencePercent: 100,
    first: { width: 1, height: 1, dataLength: 4 },
    second: { width: 1, height: 1, dataLength: 4 },
  });
});

test('cropPngBytesAsync matches the synchronous crop and keeps a full-frame box as a no-op', async () => {
  const source = PNG.sync.write(buildPatternPng(6, 6, 6));
  const box = { x: 1, y: 2, width: 4, height: 3 };

  const cropped = await runOnWorkerThread('crop', () => cropPngBytesAsync(source, box, 'fixture'));
  assert.notEqual(cropped, null);
  assert.deepEqual(cropped, cropPngBytes(source, box, 'fixture'));
  const croppedSize = PNG.sync.read(cropped as Buffer);
  assert.deepEqual([croppedSize.width, croppedSize.height], [4, 3]);

  // A box that already covers the image answers null so the caller keeps its own bytes.
  const fullFrame = await cropPngBytesAsync(source, { x: 0, y: 0, width: 6, height: 6 }, 'fixture');
  assert.equal(fullFrame, null);
});

test('decodePngAsync rejects invalid PNG data with the canonical decode AppError', async () => {
  await assert.rejects(
    () => decodePngAsync(Buffer.from('not a png'), 'fixture'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.message, /Failed to decode fixture as PNG/);
      assert.equal(error.details?.label, 'fixture');
      assert.ok(String(error.details?.reason).length > 0);
      return true;
    },
  );
});

test('decodeScreenshotImageAsync answers the synchronous decoder for both containers', async () => {
  const { encode } = await import('jpeg-js');
  const { decodeScreenshotImage } = await import('./screenshot-image.ts');
  const png = PNG.sync.write(buildPatternPng(11, 8, 4));
  const jpeg = encode({ width: 11, height: 8, data: buildPatternPng(11, 8, 4).data }, 90).data;

  for (const bytes of [png, jpeg]) {
    const fromWorker = await runOnWorkerThread('decode-image', () =>
      decodeScreenshotImageAsync(bytes, 'fixture'),
    );
    const fromSync = decodeScreenshotImage(bytes, 'fixture');

    assert.deepEqual([fromWorker.width, fromWorker.height], [fromSync.width, fromSync.height]);
    assert.deepEqual(fromWorker.data, fromSync.data);
  }
});

test('decodeScreenshotImageAsync decodes a JPEG by its bytes, not its label', async () => {
  const { encode } = await import('jpeg-js');
  const jpeg = encode({ width: 9, height: 7, data: buildPatternPng(9, 7, 5).data }, 90).data;

  const decoded = await runOnWorkerThread('decode-image', () =>
    decodeScreenshotImageAsync(jpeg, 'fixture.png'),
  );

  assert.deepEqual([decoded.width, decoded.height], [9, 7]);
  assert.equal(decoded.data.length, 9 * 7 * 4);
});

test('decodeScreenshotImageAsync rejects a container it cannot read with the canonical AppError', async () => {
  await assert.rejects(
    () => decodeScreenshotImageAsync(Buffer.from('GIF89a'), 'fixture'),
    (error) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'COMMAND_FAILED');
      assert.equal((error as AppError).message, 'fixture is neither PNG nor JPEG');
      assert.equal((error as AppError).details?.label, 'fixture');
      return true;
    },
  );

  const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 0)]);
  await assert.rejects(
    () => decodeScreenshotImageAsync(corrupt, 'fixture'),
    (error) => {
      assert.match((error as AppError).message, /Failed to decode fixture as JPEG/);
      return true;
    },
  );
});

test('the worker serves every holder and stops only when the last one lets go', async () => {
  const first = retainPngWorker(() => {});
  const second = retainPngWorker(() => {});
  const encoded = PNG.sync.write(buildPatternPng(5, 4, 2));

  await first();
  await first();
  const stillServing = await runOnWorkerThread('decode after one release', () =>
    decodePngAsync(encoded, 'fixture'),
  );
  assert.equal(stillServing.width, 5);

  await second();
  assert.equal(process.getActiveResourcesInfo().includes('MessagePort'), false);
});
