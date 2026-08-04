import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from '../png.ts';
import { resizePngFileToMaxSize } from '../png-resize.ts';
import { terminatePngWorker } from '../png-worker-client.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

afterAll(async () => {
  await terminatePngWorker();
});

test('resizePngFileToMaxSize leaves smaller images unchanged', async () => {
  const filePath = tmpPngPath('unchanged');
  const png = new PNG({ width: 4, height: 2 });
  setPngPixel(png, 3, 1, 45, 90, 135);
  fs.writeFileSync(filePath, PNG.sync.write(png));

  await resizePngFileToMaxSize(filePath, 8);

  const unchanged = PNG.sync.read(fs.readFileSync(filePath));
  assert.equal(unchanged.width, 4);
  assert.equal(unchanged.height, 2);
  assert.deepEqual(readPngPixel(unchanged, 3, 1), [45, 90, 135, 255]);
});

test('resizePngFileToMaxSize shrinks the longest edge to the limit', async () => {
  const filePath = tmpPngPath('shrunk');
  const png = new PNG({ width: 8, height: 4 });
  for (let pixel = 0; pixel < png.width * png.height; pixel += 1) {
    setPngPixel(png, pixel % png.width, Math.floor(pixel / png.width), 40, 80, 120);
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));

  await resizePngFileToMaxSize(filePath, 4);

  const resized = PNG.sync.read(fs.readFileSync(filePath));
  assert.equal(resized.width, 4);
  assert.equal(resized.height, 2);
  assert.deepEqual(readPngPixel(resized, 3, 1), [40, 80, 120, 255]);
});

function tmpPngPath(prefix: string): string {
  return path.join(mkdtempForTestSync(`agent-device-png-${prefix}-`), 'image.png');
}

function setPngPixel(
  png: PNG,
  x: number,
  y: number,
  red: number,
  green: number,
  blue: number,
  alpha = 255,
): void {
  const offset = (y * png.width + x) * 4;
  png.data[offset] = red;
  png.data[offset + 1] = green;
  png.data[offset + 2] = blue;
  png.data[offset + 3] = alpha;
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
