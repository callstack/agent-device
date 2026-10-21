import { AppError } from '@agent-device/kernel/errors';
import { hasPngSignature } from './png.ts';

/** Checks the decoded allocation budget before either codec allocates pixel rows. */
export function validateScreenshotImagePixels(
  bytes: Buffer,
  label: string,
  maxPixels?: number,
): void {
  if (maxPixels == null || maxPixels <= 0) return;
  if (hasPngSignature(bytes)) {
    validatePngPixels(bytes, label, maxPixels);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    validateJpegPixels(bytes, label, maxPixels);
  }
}

function validatePngPixels(bytes: Buffer, label: string, maxPixels: number): void {
  let offset = 8;
  while (offset + 16 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR' && length >= 8) {
      validateScreenshotPixels(
        bytes.readUInt32BE(offset + 8),
        bytes.readUInt32BE(offset + 12),
        label,
        maxPixels,
      );
    }
    if (type === 'IEND') return;
    offset += length + 12;
  }
}

function validateJpegPixels(bytes: Buffer, label: string, maxPixels: number): void {
  for (const { marker, offset, length } of jpegSegments(bytes)) {
    // These are the three frame types supported by the screenshot JPEG decoder.
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      validateScreenshotPixels(
        bytes.readUInt16BE(offset + 5),
        bytes.readUInt16BE(offset + 3),
        label,
        maxPixels,
      );
    }
  }
}

function* jpegSegments(
  bytes: Buffer,
): Generator<{ marker: number; offset: number; length: number }> {
  let offset = 2;
  while (offset + 3 < bytes.length && bytes[offset] === 0xff) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xda || marker === 0xd9) return;
    if (offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    yield { marker, offset, length };
    offset += length;
  }
}

/** Bounds original, resized and comparison canvases with the same pixel budget. */
export function validateScreenshotPixels(
  width: number,
  height: number,
  label: string,
  maxPixels?: number,
): void {
  const pixels = width * height;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels < 1 ||
    (maxPixels != null && maxPixels > 0 && pixels > maxPixels)
  ) {
    throw new AppError(
      'INVALID_ARGS',
      `${label} is ${pixels} pixels, which exceeds the configured maxImagePixels limit of ${maxPixels}`,
    );
  }
}
