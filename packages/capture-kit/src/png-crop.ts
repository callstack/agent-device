import { promises as fs } from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import { PNG } from './png.ts';
import { decodePngAsync, encodePngAsync } from './png-worker-client.ts';

/**
 * Crops `filePath` in place to `box` (positive integer pixels). `box` is the caller's
 * already-intersected region, so one outside the image is a caller bug — refused, not clamped.
 * Decode and encode run on the PNG worker thread; a full-image box is a no-op.
 */
export async function cropPngFile(filePath: string, box: Rect): Promise<void> {
  if (!isCropBox(box)) {
    throw new AppError(
      'INVALID_ARGS',
      'Screenshot crop box must be positive integer pixel offsets',
    );
  }

  const source = await decodePngAsync(await fs.readFile(filePath), 'screenshot');
  if (box.x + box.width > source.width || box.y + box.height > source.height) {
    throw new AppError(
      'INVALID_ARGS',
      `Screenshot crop box ${box.width}x${box.height} at (${box.x}, ${box.y}) exceeds the ${source.width}x${source.height} image`,
    );
  }
  if (box.x === 0 && box.y === 0 && box.width === source.width && box.height === source.height) {
    return;
  }

  await fs.writeFile(filePath, await encodePngAsync(cropPngBox(source, box)));
}

function isCropBox(box: Rect): boolean {
  return (
    Number.isInteger(box.x) &&
    box.x >= 0 &&
    Number.isInteger(box.y) &&
    box.y >= 0 &&
    Number.isInteger(box.width) &&
    box.width > 0 &&
    Number.isInteger(box.height) &&
    box.height > 0
  );
}

function cropPngBox(source: PNG, box: Rect): PNG {
  const output = new PNG({ width: box.width, height: box.height });
  for (let row = 0; row < box.height; row += 1) {
    const sourceStart = ((row + box.y) * source.width + box.x) * 4;
    source.data.copy(output.data, row * output.width * 4, sourceStart, sourceStart + box.width * 4);
  }
  return output;
}
