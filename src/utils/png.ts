import { AppError } from '../kernel/errors.ts';
import { PNG } from './png-codec.ts';

export { PNG };

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
