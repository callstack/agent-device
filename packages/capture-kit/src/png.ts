import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { PNG } from 'pngjs';

export { PNG };

/**
 * Why a screenshot image did not decode. The two containers are refused apart, so a caller tells a
 * corrupt PNG from a corrupt JPEG without reading the decoder's prose, which now travels as
 * `details.decoderError`.
 */
export const IMAGE_DECODE_REASONS = {
  // The bytes carry a PNG signature but the PNG decoder could not read them.
  pngDecodeFailed: { reason: 'png_decode_failed' },
  // The bytes carry a JPEG signature but the JPEG decoder could not read them.
  jpegDecodeFailed: { reason: 'jpeg_decode_failed' },
} as const satisfies ReasonTable<'image decoding'>;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether the bytes open with the PNG signature, before any decode is attempted. */
export function hasPngSignature(bytes: Buffer): boolean {
  return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/**
 * Decodes a PNG, wrapping failures in the canonical decode `AppError`. Shared
 * by the in-process sync path and the PNG worker thread (`png-worker.ts`), so
 * both report identical errors.
 */
export function decodePng(buffer: Buffer, label: string): PNG {
  try {
    return PNG.sync.read(buffer);
  } catch (error) {
    throw new AppError('COMMAND_FAILED', `Failed to decode ${label} as PNG`, {
      label,
      reason: IMAGE_DECODE_REASONS.pngDecodeFailed.reason,
      decoderError: error instanceof Error ? error.message : String(error),
    });
  }
}
