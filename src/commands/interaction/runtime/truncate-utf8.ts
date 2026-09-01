const TRUNCATION_MARKER = '…';

/**
 * Truncates `value` to at most `maxBytes` UTF-8 bytes, appending
 * `TRUNCATION_MARKER` when truncation happens. Never splits a multi-byte
 * UTF-8 sequence: the cut point backs off past any trailing continuation
 * bytes (`10xxxxxx`) before the marker is appended.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  const buffer = Buffer.from(value, 'utf8');
  let end = Math.min(budget, buffer.length);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8') + TRUNCATION_MARKER;
}
