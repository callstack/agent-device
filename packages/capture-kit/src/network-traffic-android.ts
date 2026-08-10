import type { NetworkEntry } from '@agent-device/contracts/observability';
import { parseNetworkStatusCode, parseNetworkTimestamp } from './network-traffic-value.ts';

const NEARBY_LINE_RADIUS = 5;
const PACKET_SCAN_RADIUS = 12;

export function enrichNetworkEntryFromAndroidLines(
  result: NetworkEntry,
  lines: string[],
  lineIndex: number,
): void {
  const nearby = collectNearbyLines(lines, lineIndex, NEARBY_LINE_RADIUS);
  const packetId =
    result.packetId ??
    nearby
      .map(parseAndroidPacketId)
      .find((value): value is string => typeof value === 'string' && value.length > 0);
  if (packetId) result.packetId = packetId;

  const related = packetId
    ? collectNearbyLines(lines, lineIndex, PACKET_SCAN_RADIUS).filter(
        (line) => parseAndroidPacketId(line) === packetId,
      )
    : nearby;
  result.timestamp ??= related
    .map(parseNetworkTimestamp)
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  result.status ??=
    related
      .map(parseNetworkStatusCode)
      .find((value): value is number => typeof value === 'number') ?? undefined;
  result.durationMs ??=
    related
      .map(parseAndroidDurationMs)
      .find((value): value is number => typeof value === 'number') ?? undefined;
}

export function parseAndroidPacketId(line: string): string | null {
  return /\bpacket id (\d+)\b/i.exec(line)?.[1] ?? null;
}

export function parseAndroidDurationMs(line: string): number | null {
  const match = /\b(?:duration|elapsed request\/response time, ms)[:= ]+(\d+)\b/i.exec(line);
  return match ? Number.parseInt(match[1] ?? '', 10) : null;
}

function collectNearbyLines(lines: string[], index: number, radius: number): string[] {
  return lines
    .slice(Math.max(0, index - radius), Math.min(lines.length, index + radius + 1))
    .map((line) => line.trim())
    .filter(Boolean);
}
