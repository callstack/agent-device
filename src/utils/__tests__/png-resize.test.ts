import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from '../png.ts';
import { resizePngFileToScale } from '../png-resize.ts';
import { terminatePngWorker } from '../png-worker-client.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

afterAll(async () => {
  await terminatePngWorker();
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
