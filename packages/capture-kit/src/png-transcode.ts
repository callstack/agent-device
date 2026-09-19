import { AppError } from '@agent-device/kernel/errors';
import { decode as decodeJpeg } from 'jpeg-js';
import { hasPngSignature, PNG } from './png.ts';

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export type ScreenshotImageFormat = 'png' | 'jpeg';

/** Names the container a screenshot arrived in from its magic bytes, or `undefined` for neither. */
export function detectScreenshotImageFormat(bytes: Buffer): ScreenshotImageFormat | undefined {
  if (hasPngSignature(bytes)) return 'png';
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return 'jpeg';
  return undefined;
}

/**
 * Returns PNG bytes for a screenshot a provider handed back in whatever container it prefers. PNG
 * passes through untouched; JPEG is decoded and re-encoded losslessly from the decoded pixels, so
 * every PNG-only reader downstream (size, crop, overlay, diff) sees the format the path promises.
 *
 * Synchronous and CPU-bound: daemon request paths reach it through the PNG worker
 * (`transcodeScreenshotToPngAsync` in `png-worker-client.ts`), like every other codec job.
 */
export function transcodeScreenshotToPng(bytes: Buffer, label: string): Buffer {
  const format = detectScreenshotImageFormat(bytes);
  if (format === 'png') return bytes;
  if (format === 'jpeg') return jpegToPng(bytes, label);
  throw new AppError('COMMAND_FAILED', `${label} is neither PNG nor JPEG`, {
    label,
    leadingBytes: bytes.subarray(0, 4).toString('hex'),
  });
}

/** A JPEG signature does not prove a decodable body; a failure keeps the label and the decoder's reason. */
function jpegToPng(bytes: Buffer, label: string): Buffer {
  try {
    const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
    const png = new PNG({ width: decoded.width, height: decoded.height });
    png.data = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
    return PNG.sync.write(png);
  } catch (error) {
    throw new AppError('COMMAND_FAILED', `Failed to decode ${label} as JPEG`, {
      label,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
