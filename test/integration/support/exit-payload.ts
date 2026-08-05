// Large payload for the #1596 exit-flush fixture, ending with a marker that
// proves the whole write reached the parent process.
export const PAYLOAD_MARKER = 'EXIT_PAYLOAD_END_MARKER';
const PAYLOAD_BYTES = 200_000;

export function buildPayload(): string {
  const body = 'x'.repeat(PAYLOAD_BYTES - PAYLOAD_MARKER.length - 1);
  return `${body}${PAYLOAD_MARKER}\n`;
}
