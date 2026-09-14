import { promises as fs } from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import { cropPngBytesAsync } from './png-worker-client.ts';

/**
 * Crops `filePath` in place to `box` (positive integer pixels). `box` is the caller's
 * already-intersected region, so one outside the image is a caller bug — refused, not clamped.
 * One PNG worker job turns the captured bytes into the cropped bytes, so the decoded image never
 * leaves the worker thread; a box that already covers the image leaves the file untouched.
 */
export async function cropPngFile(filePath: string, box: Rect): Promise<void> {
  if (!isCropBox(box)) {
    throw new AppError(
      'INVALID_ARGS',
      'Screenshot crop box must be positive integer pixel offsets',
    );
  }
  const cropped = await cropPngBytesAsync(await fs.readFile(filePath), box, 'screenshot');
  if (cropped !== null) {
    await fs.writeFile(filePath, cropped);
  }
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
