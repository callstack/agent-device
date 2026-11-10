import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';

function looksLikeInlineJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}

export type ResolvedPayloadInput =
  | { kind: 'file'; path: string }
  | { kind: 'inline'; text: string };

export type PayloadPathOptions = {
  /** Maps a path argument to the path to stat, for example against the caller's cwd. */
  resolvePath?: (value: string) => string;
};

/** Error codes that prove the value names no existing file, so it may still be inline JSON. */
const NO_SUCH_FILE_CODES = new Set(['ENOENT', 'ENAMETOOLONG', 'ENOTDIR']);

export function resolvePayloadInput(
  value: string,
  options?: { subject?: string } & PayloadPathOptions,
): ResolvedPayloadInput {
  const subject = options?.subject ?? 'Payload';
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AppError('INVALID_ARGS', `${subject} cannot be empty`);
  }

  const resolvedPath = options?.resolvePath ? options.resolvePath(trimmed) : trimmed;

  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new AppError('INVALID_ARGS', `${subject} path is not a file: ${resolvedPath}`);
    }
    return { kind: 'file', path: resolvedPath };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AppError('INVALID_ARGS', `${subject} file is not readable: ${resolvedPath}`);
    }
    if (code && !NO_SUCH_FILE_CODES.has(code)) {
      throw new AppError('COMMAND_FAILED', `Unable to read ${subject} file: ${resolvedPath}`, {
        cause: String(error),
      });
    }
  }

  if (looksLikeInlineJson(trimmed)) {
    return { kind: 'inline', text: trimmed };
  }
  throw new AppError('INVALID_ARGS', `${subject} file not found: ${resolvedPath}`);
}
