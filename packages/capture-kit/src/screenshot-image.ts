import { AppError } from '@agent-device/kernel/errors';
import { decode as decodeJpeg } from 'jpeg-js';
import { decodePng, hasPngSignature, PNG } from './png.ts';
import { validateScreenshotImagePixels } from './screenshot-image-size.ts';

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export type ScreenshotImageFormat = 'png' | 'jpeg';

/** Names the container a screenshot arrived in from its magic bytes, or `undefined` for neither. */
export function detectScreenshotImageFormat(bytes: Buffer): ScreenshotImageFormat | undefined {
  if (hasPngSignature(bytes)) return 'png';
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return 'jpeg';
  return undefined;
}

/**
 * Decodes a screenshot in whatever container it arrived in into the RGBA rows every pixel reader in
 * this repository consumes. The container is sniffed, never trusted from a file name or a caller's
 * guess, so a JPEG stored under a `.png` name still decodes.
 *
 * Synchronous and CPU-bound: daemon request paths reach it through the PNG worker
 * (`decodeScreenshotImageAsync` in `png-worker-client.ts`), like every other codec job.
 */
export function decodeScreenshotImage(bytes: Buffer, label: string, maxPixels?: number): PNG {
  validateScreenshotImagePixels(bytes, label, maxPixels);
  const format = detectScreenshotImageFormat(bytes);
  if (format === 'png') return decodePng(bytes, label);
  if (format === 'jpeg') return decodeJpegImage(bytes, label, maxPixels);
  throw unsupportedContainer(label, bytes);
}

/** A JPEG signature does not prove a decodable body; a failure keeps the label and the decoder's reason. */
function decodeJpegImage(bytes: Buffer, label: string, maxPixels?: number): PNG {
  try {
    const decoded = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      // The decoder also checks frames reached through its malformed-marker recovery.
      // A half pixel keeps floating-point MP conversion away from integer budget boundaries.
      ...(maxPixels != null && maxPixels > 0
        ? { maxResolutionInMP: (Math.floor(maxPixels) + 0.5) / 1_000_000 }
        : {}),
    });
    const png = new PNG({ width: decoded.width, height: decoded.height });
    png.data = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
    return png;
  } catch (error) {
    throw new AppError('COMMAND_FAILED', `Failed to decode ${label} as JPEG`, {
      label,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function unsupportedContainer(label: string, bytes: Buffer): AppError {
  return new AppError('COMMAND_FAILED', `${label} is neither PNG nor JPEG`, {
    label,
    leadingBytes: bytes.subarray(0, 4).toString('hex'),
  });
}
