import { AppError } from '@agent-device/kernel/errors';

export type UploadContentRange = {
  start: number;
  end: number;
  size: number;
  span: number;
};

export function parseUploadContentRange(
  value: string | string[] | undefined,
  expectedSize: number,
): UploadContentRange | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const match = raw.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) invalidRange();
  const start = Number(match[1]);
  const end = Number(match[2]);
  const size = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    end < start ||
    end >= size ||
    size < 1 ||
    size !== expectedSize
  ) {
    invalidRange();
  }
  return { start, end, size, span: end - start + 1 };
}

export function parseUploadContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new AppError('INVALID_ARGS', 'Invalid content-length header');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError('INVALID_ARGS', 'Invalid content-length header');
  }
  return parsed;
}

function invalidRange(): never {
  throw new AppError('INVALID_ARGS', 'Invalid content-range header');
}
