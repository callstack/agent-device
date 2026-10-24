import type {
  NetworkDump,
  NetworkDumpParserOptions,
} from '@agent-device/contracts/network-traffic';
import type { NetworkEntry } from '@agent-device/contracts/observability';
import { resolveNetworkDumpLimits, truncateNetworkText } from './network-traffic.ts';

/**
 * One line of the iOS simulator capture probe's file (ADR 0037). The probe writes one JSON object
 * per completed URLSession task; every field is optional because the file is written by code
 * injected into an app this package does not build, so a partial line is a line to skip, never a
 * reason to fail the dump.
 */
type NetworkProbeRecord = Readonly<{
  method?: unknown;
  url?: unknown;
  status?: unknown;
  duration_ms?: unknown;
  timestamp_ms?: unknown;
  request_headers?: unknown;
  response_headers?: unknown;
  error?: unknown;
}>;

export type NetworkProbeScan = Readonly<{
  dump: NetworkDump;
}>;

/**
 * Reads the capture probe's JSON-lines window into the same `NetworkDump` shape the app-log parser
 * produces, newest first, so the response and the renderer treat both sources alike. Unlike the
 * log parser, this reader never guesses: a line without a URL is not traffic this dump can name, so
 * it is skipped.
 */
export function readNetworkProbeTrafficFromText(
  content: string,
  options: NetworkDumpParserOptions,
): NetworkProbeScan {
  const { include, limits } = resolveNetworkDumpLimits(options);
  const { maxEntries, maxScanLines, maxPayloadChars } = limits;
  if (!options.exists) {
    return Object.freeze({
      dump: Object.freeze({
        path: options.path,
        exists: false,
        scannedLines: 0,
        matchedLines: 0,
        entries: Object.freeze([]),
        include,
        limits,
      }),
    });
  }
  const allLines = content.split('\n');
  const startIndex = Math.max(0, allLines.length - maxScanLines);
  const lines = allLines.slice(startIndex);
  const entries: NetworkEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < maxEntries; i -= 1) {
    const entry = parseProbeLine(lines[i] ?? '', options, startIndex + i, include, maxPayloadChars);
    if (entry) entries.push(entry);
  }
  return Object.freeze({
    dump: Object.freeze({
      path: options.path,
      exists: true,
      scannedLines: lines.length,
      matchedLines: entries.length,
      entries: Object.freeze(entries),
      include,
      limits,
    }),
  });
}

function parseProbeLine(
  line: string,
  options: NetworkDumpParserOptions,
  index: number,
  include: NonNullable<NetworkDumpParserOptions['include']>,
  maxPayloadChars: number,
): NetworkEntry | undefined {
  const record = line.trim() ? parseProbeRecord(line) : undefined;
  const url = typeof record?.url === 'string' ? record.url.trim() : '';
  if (!url) return undefined;
  const status = optionalInteger(record?.status, (value) => Number.isInteger(value));
  const durationMs = optionalInteger(record?.duration_ms, (value) => Number.isFinite(value), 0);
  const error = typedText(record?.error);
  const method = typedText(record?.method);
  const timestamp = probeTimestamp(record);
  const headers =
    include === 'headers' || include === 'all'
      ? formatProbeHeaders(record, maxPayloadChars)
      : undefined;
  const entry: NetworkEntry = {
    url,
    raw: line.trim(),
    line: (options.lineNumberOffset ?? 0) + index + 1,
  };
  if (method) entry.method = method;
  if (status !== undefined) entry.status = status;
  if (timestamp) entry.timestamp = timestamp;
  if (durationMs !== undefined) entry.durationMs = durationMs;
  if (error) entry.error = error;
  if (headers) entry.headers = headers;
  return Object.freeze(entry);
}

/** The probe's own text field, present only when it carries a non-empty string. */
function typedText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function optionalInteger(
  value: unknown,
  accepts: (number: number) => boolean,
  roundTo?: number,
): number | undefined {
  if (typeof value !== 'number' || !accepts(value)) return undefined;
  return roundTo === undefined ? value : Math.max(roundTo, Math.round(value));
}

function parseProbeRecord(line: string): NetworkProbeRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as NetworkProbeRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function probeTimestamp(record: NetworkProbeRecord | undefined): string | undefined {
  const value = record?.timestamp_ms;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value).toISOString();
}

function formatProbeHeaders(
  record: NetworkProbeRecord | undefined,
  maxPayloadChars: number,
): string | undefined {
  const request = formatProbeHeaderGroup('request', record?.request_headers);
  const response = formatProbeHeaderGroup('response', record?.response_headers);
  const text = [request, response].filter(Boolean).join('\n');
  return text ? truncateNetworkText(text, maxPayloadChars) : undefined;
}

function formatProbeHeaderGroup(label: string, value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  if (entries.length === 0) return '';
  return [`${label}:`, ...entries.map(([key, header]) => `  ${key}: ${header}`)].join('\n');
}
