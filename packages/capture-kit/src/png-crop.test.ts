import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from './png.ts';
import { cropPngFile } from './png-crop.ts';
import { terminatePngWorker } from './png-worker-client.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

afterAll(async () => {
  await terminatePngWorker();
});

test('cropPngFile keeps only the box rows and columns, in place', async () => {
  const filePath = writeCheckedPng();
  await cropPngFile(filePath, { x: 2, y: 1, width: 3, height: 2 });

  const cropped = PNG.sync.read(fs.readFileSync(filePath));
  assert.equal(cropped.width, 3);
  assert.equal(cropped.height, 2);
  assert.deepEqual(readPngPixel(cropped, 0, 0), pixel(2, 1));
  assert.deepEqual(readPngPixel(cropped, 2, 1), pixel(4, 2));
});

test('a box grazing the image edges crops to the edge without clamping the origin', async () => {
  const filePath = writeCheckedPng();
  await cropPngFile(filePath, { x: 4, y: 2, width: 2, height: 2 });

  const cropped = PNG.sync.read(fs.readFileSync(filePath));
  assert.equal(cropped.width, 2);
  assert.equal(cropped.height, 2);
  assert.deepEqual(readPngPixel(cropped, 1, 1), pixel(5, 3));
});

test('a full-image box is a no-op that leaves the file decodable at the same size', async () => {
  const filePath = writeCheckedPng();
  const before = fs.readFileSync(filePath);
  await cropPngFile(filePath, { x: 0, y: 0, width: 6, height: 4 });
  assert.deepEqual(fs.readFileSync(filePath), before);
});

test('boxes that exceed the image refuse instead of clamping', async () => {
  const filePath = writeCheckedPng();
  await assert.rejects(
    () => cropPngFile(filePath, { x: 5, y: 3, width: 3, height: 3 }),
    (error: unknown) => error instanceof Error && error.message.includes('exceeds'),
  );
});

test('non-integer or non-positive boxes refuse', async () => {
  const filePath = writeCheckedPng();
  const boxes = [
    { x: 1.5, y: 0, width: 2, height: 2 },
    { x: 0, y: -1, width: 2, height: 2 },
    { x: 0, y: 0, width: 0, height: 2 },
    { x: 0, y: 0, width: 2, height: 0 },
  ] as const;
  for (const box of boxes) {
    await assert.rejects(
      () => cropPngFile(filePath, box),
      (error: unknown) => error instanceof Error && error.message.includes('positive integer'),
      JSON.stringify(box),
    );
  }
});

// A 6x4 grid whose pixel (x, y) carries (x*10, y*10) so a wrong source offset
// is caught by the value, not just the size.
function writeCheckedPng(): string {
  const filePath = path.join(mkdtempForTestSync('agent-device-png-crop-'), 'image.png');
  const png = new PNG({ width: 6, height: 4 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      png.data[offset] = x * 10;
      png.data[offset + 1] = y * 10;
      png.data[offset + 2] = 0;
      png.data[offset + 3] = 255;
    }
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
  return filePath;
}

function pixel(x: number, y: number): number[] {
  return [x * 10, y * 10, 0, 255];
}

function readPngPixel(png: PNG, x: number, y: number): number[] {
  const offset = (y * png.width + x) * 4;
  return [
    png.data[offset] ?? 0,
    png.data[offset + 1] ?? 0,
    png.data[offset + 2] ?? 0,
    png.data[offset + 3] ?? 0,
  ];
}
