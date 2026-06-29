import fs from 'node:fs';
import { AppError } from '../kernel/errors.ts';

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

export function resolvePayloadInput(
  value: string,
  options?: {
    subject?: string;
    cwd?: string;
    expandPath?: (value: string, cwd?: string) => string;
  },
): ResolvedPayloadInput {
  const subject = options?.subject ?? 'Payload';
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AppError('INVALID_ARGS', `${subject} cannot be empty`);
  }

  const resolvedPath = options?.expandPath ? options.expandPath(trimmed, options.cwd) : trimmed;

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
    if (code && code !== 'ENOENT') {
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
