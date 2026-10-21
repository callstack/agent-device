import { AppError } from '@agent-device/kernel/errors';
import { hasPngSignature } from './png.ts';

/** Checks the decoded allocation budget before either codec allocates pixel rows. */
export function validateScreenshotImagePixels(
  bytes: Buffer,
  label: string,
  maxPixels?: number,
): void {
  if (maxPixels == null || maxPixels <= 0) return;
  if (hasPngSignature(bytes) && bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    validateScreenshotPixels(bytes.readUInt32BE(16), bytes.readUInt32BE(20), label, maxPixels);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    validateJpegPixels(bytes, label, maxPixels);
  }
}

function validateJpegPixels(bytes: Buffer, label: string, maxPixels: number): void {
  let offset = 2;
  while (offset + 3 < bytes.length && bytes[offset] === 0xff) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return;
    if (marker === 0x01 || (marker != null && marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    // These are the three frame types supported by the screenshot JPEG decoder.
    if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && length >= 8) {
      validateScreenshotPixels(
        bytes.readUInt16BE(offset + 5),
        bytes.readUInt16BE(offset + 3),
        label,
        maxPixels,
      );
    }
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
