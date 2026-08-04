// Shared payload for the #1596 exit-flush fixtures: sized past a pipe's
// kernel buffer (64 KiB on macOS/Linux) so a truncated write is observable,
// and ends with a marker that only survives the write if it wasn't cut off.
export const PAYLOAD_MARKER = 'EXIT_PAYLOAD_END_MARKER';
const PAYLOAD_BYTES = 200_000;

export function buildPayload(): string {
  const body = 'x'.repeat(PAYLOAD_BYTES - PAYLOAD_MARKER.length - 1);
  return `${body}${PAYLOAD_MARKER}\n`;
}
