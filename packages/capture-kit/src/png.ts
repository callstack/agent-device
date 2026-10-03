import { AppError } from '@agent-device/kernel/errors';
import { PNG } from 'pngjs';

export { PNG };

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
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
