import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from './png.ts';
import { resizePngBox, resizePngFileToScale } from './png-resize.ts';
import { terminatePngWorker } from './png-worker-client.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

afterAll(async () => {
  await terminatePngWorker();
});

test('whole-pixel boxes average each RGBA channel across unequal axis factors', () => {
  const source = new PNG({ width: 4, height: 6 });
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      setPngPixel(source, x, y, x * 10 + y * 20, x + y * 10, 200 - x - y * 4, (x + y) * 20);
    }
  }
  const resized = resizePngBox(source, 2, 2);
  assert.deepEqual(
    [...resized.data],
    [25, 11, 196, 30, 45, 13, 194, 70, 85, 41, 184, 90, 105, 43, 182, 130],
  );
});

test('fractional boxes retain overlap weights for every RGBA channel', () => {
  const source = new PNG({ width: 3, height: 1 });
  source.data = Buffer.from([0, 0, 10, 0, 60, 30, 40, 90, 120, 60, 70, 180]);
  const resized = resizePngBox(source, 2, 1);
  assert.deepEqual([...resized.data], [20, 10, 20, 30, 100, 50, 60, 150]);
});

test('resizePngFileToScale shrinks both dimensions proportionally', async () => {
  const filePath = tmpPngPath('scaled');
  const png = new PNG({ width: 10, height: 4 });
  for (let pixel = 0; pixel < png.width * png.height; pixel += 1) {
    setPngPixel(png, pixel % png.width, Math.floor(pixel / png.width), 40, 80, 120);
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));

  await resizePngFileToScale(filePath, 0.3);

  const resized = PNG.sync.read(fs.readFileSync(filePath));
  assert.equal(resized.width, 3);
  assert.equal(resized.height, 1);
  assert.deepEqual(readPngPixel(resized, 2, 0), [40, 80, 120, 255]);
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
