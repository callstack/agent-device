import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import { decodePng, PNG } from './png.ts';
import { encodePngPixels } from './png-encode.ts';
import { decodePngRegion, readPngRegionHeader } from './png-region-decode.ts';

/**
 * Crops PNG bytes to `box` (positive integer pixels), synchronously and without handing the
 * decoded image to anybody else. Returns `null` when the box already covers the image, which
 * tells the caller its file is already the answer.
 *
 * The region reader serves the 8-bit truecolor layout device captures arrive in and writes the
 * result without an alpha channel when the cropped pixels carry none. Every other layout, and
 * any file the region reader declines to interpret, goes through the general PNG reader, which
 * owns the canonical decode error and keeps the previous RGBA output.
 */
export function cropPngBytes(source: Buffer, box: Rect, label: string): Buffer | null {
  const header = readPngRegionHeader(source);
  if (header !== null && !isFullImageBox(box, header.width, header.height)) {
    assertCropBoxFits(box, header.width, header.height);
    const region = decodePngRegion(source, header, box);
    if (region !== null) {
      return encodePngPixels(region.pixels, region.width, region.height, region.channels);
    }
  }
  return cropDecodedPng(source, box, label);
}

function cropDecodedPng(bytes: Buffer, box: Rect, label: string): Buffer | null {
  const decoded = decodePng(bytes, label);
  assertCropBoxFits(box, decoded.width, decoded.height);
  if (isFullImageBox(box, decoded.width, decoded.height)) return null;
  return PNG.sync.write(copyPngBox(decoded, box));
}

function copyPngBox(source: PNG, box: Rect): PNG {
  const output = new PNG({ width: box.width, height: box.height });
  for (let row = 0; row < box.height; row += 1) {
    const sourceStart = ((row + box.y) * source.width + box.x) * 4;
    source.data.copy(output.data, row * output.width * 4, sourceStart, sourceStart + box.width * 4);
  }
  return output;
}

function assertCropBoxFits(box: Rect, width: number, height: number): void {
  if (box.x + box.width > width || box.y + box.height > height) {
    throw new AppError(
      'INVALID_ARGS',
      `Screenshot crop box ${box.width}x${box.height} at (${box.x}, ${box.y}) exceeds the ${width}x${height} image`,
    );
  }
}

function isFullImageBox(box: Rect, width: number, height: number): boolean {
  return box.x === 0 && box.y === 0 && box.width === width && box.height === height;
}
