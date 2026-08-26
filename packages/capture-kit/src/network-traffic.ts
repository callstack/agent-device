import type {
  NetworkDump,
  NetworkDumpParserOptions,
} from '@agent-device/contracts/network-traffic';
import type { LogBackend, NetworkEntry } from '@agent-device/contracts/observability';
import {
  enrichNetworkEntryFromAndroidLines,
  parseAndroidDurationMs,
  parseAndroidPacketId,
} from './network-traffic-android.ts';
import {
  parseEmbeddedNetworkJson,
  parseNetworkStatusCode,
  parseNetworkTimestamp,
  readNetworkBody,
  readNetworkHeaders,
  readNetworkJsonNumber,
  readNetworkJsonString,
} from './network-traffic-value.ts';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const METHOD_WITH_URL_REGEX = new RegExp(`\\b(${HTTP_METHODS.join('|')})\\b\\s+https?:\\/\\/`, 'i');
const URL_REGEX = /https?:\/\/[^\s"'<>\])]+/i;

export function mergeNetworkDumps(
  primary: NetworkDump,
  secondary: NetworkDump,
  maxEntries = primary.limits.maxEntries,
): NetworkDump {
  const entries = [...primary.entries];
  const seen = new Set(entries.map(networkEntryKey));
  for (const entry of secondary.entries) {
    const key = networkEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= maxEntries) break;
  }
  return Object.freeze({
    ...primary,
    matchedLines: entries.length,
    entries: Object.freeze(entries),
  });
}

export function readRecentNetworkTrafficFromText(
  content: string,
  options: NetworkDumpParserOptions,
): NetworkDump {
  const maxEntries = clampInt(options.maxEntries, 25, 1, 200);
  const include = options.include ?? 'summary';
  const maxPayloadChars = clampInt(options.maxPayloadChars, 2048, 64, 16_384);
  const maxScanLines = clampInt(options.maxScanLines, 4000, 100, 20_000);
  const lineNumberOffset = requireLineNumberOffset(options.lineNumberOffset);
  if (!options.exists) {
    return Object.freeze({
      path: options.path,
      exists: false,
      scannedLines: 0,
      matchedLines: 0,
      entries: Object.freeze([]),
      include,
      limits: Object.freeze({ maxEntries, maxPayloadChars, maxScanLines }),
    });
  }
  const allLines = content.split('\n');
  const startIndex = Math.max(0, allLines.length - maxScanLines);
  const lines = allLines.slice(startIndex);
  const entries: NetworkEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < maxEntries; i -= 1) {
    if (!lines[i]?.trim()) continue;
    const parsed = parseNetworkLine(
      lines,
      i,
      lineNumberOffset + startIndex + i + 1,
      options.backend,
      include,
      maxPayloadChars,
    );
    if (parsed) entries.push(parsed);
  }
  return Object.freeze({
    path: options.path,
    exists: true,
    scannedLines: lines.length,
    matchedLines: entries.length,
    entries: Object.freeze(entries),
    include,
    limits: Object.freeze({ maxEntries, maxPayloadChars, maxScanLines }),
  });
}

function requireLineNumberOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError('Network line number offset must be a non-negative integer');
  }
  return value;
}

function parseNetworkLine(
  lines: string[],
  lineIndex: number,
  lineNumber: number,
  backend: LogBackend | undefined,
  include: NetworkDump['include'],
  maxPayloadChars: number,
): NetworkEntry | null {
  const line = lines[lineIndex]?.trim();
  if (!line) return null;
  const maybeJson = parseEmbeddedNetworkJson(line);
  const identity = parseNetworkIdentity(line, maybeJson);
  if (!identity) return null;
  const result = createNetworkEntry(line, lineNumber, identity, maxPayloadChars);
  if (backend === 'android') enrichNetworkEntryFromAndroidLines(result, lines, lineIndex);
  applyNetworkProjection(result, line, maybeJson, include, maxPayloadChars);
  return result;
}

type NetworkIdentity = Readonly<{
  method?: string;
  url: string;
  status?: number;
}>;

function parseNetworkIdentity(
  line: string,
  maybeJson: Record<string, unknown> | null,
): NetworkIdentity | null {
  const method = parseNetworkMethod(line, maybeJson);
  const url = parseNetworkUrl(line, maybeJson);
  if (!url) return null;
  const status = parseNetworkStatus(line, maybeJson);
  if (!hasExplicitNetworkSignal(line, method.explicit, status)) {
    return null;
  }
  return { method: method.value, url, status };
}

function parseNetworkMethod(
  line: string,
  maybeJson: Record<string, unknown> | null,
): Readonly<{ value?: string; explicit: boolean }> {
  const jsonMethod = readNetworkJsonString(maybeJson, ['method', 'httpMethod']);
  const fieldMethod = /\bmethod["'=: ]+([A-Z]+)\b/i.exec(line)?.[1];
  const inlineMethod = METHOD_WITH_URL_REGEX.exec(line)?.[1];
  const value = jsonMethod ?? fieldMethod ?? inlineMethod;
  return { value: value?.toUpperCase(), explicit: Boolean(value) };
}

function parseNetworkUrl(
  line: string,
  maybeJson: Record<string, unknown> | null,
): string | undefined {
  return readNetworkJsonString(maybeJson, ['url', 'requestUrl']) ?? URL_REGEX.exec(line)?.[0];
}

function parseNetworkStatus(
  line: string,
  maybeJson: Record<string, unknown> | null,
): number | undefined {
  return (
    readNetworkJsonNumber(maybeJson, ['status', 'statusCode', 'responseCode']) ??
    parseNetworkStatusCode(line) ??
    undefined
  );
}

function hasExplicitNetworkSignal(
  line: string,
  method: boolean,
  status: number | undefined,
): boolean {
  return (
    method ||
    status !== undefined ||
    /\bURL["'=: ]+https?:\/\//i.test(line) ||
    /\bheaders?["'=: ]+/i.test(line) ||
    /\b(?:requestBody|responseBody|payload|request|response)["'=: ]+/i.test(line)
  );
}

function createNetworkEntry(
  line: string,
  lineNumber: number,
  identity: NetworkIdentity,
  maxPayloadChars: number,
): NetworkEntry {
  return {
    ...identity,
    timestamp: parseNetworkTimestamp(line),
    packetId: parseAndroidPacketId(line) ?? undefined,
    durationMs: parseAndroidDurationMs(line) ?? undefined,
    raw: truncate(line, maxPayloadChars),
    line: lineNumber,
  };
}

function applyNetworkProjection(
  result: NetworkEntry,
  line: string,
  maybeJson: Record<string, unknown> | null,
  include: NetworkDump['include'],
  maxPayloadChars: number,
): void {
  if (includesHeaders(include)) {
    const headers = readNetworkHeaders(line, maybeJson);
    if (headers) result.headers = truncate(headers, maxPayloadChars);
  }
  if (includesBody(include)) {
    const requestBody = readNetworkBody(line, maybeJson, [
      'requestBody',
      'body',
      'payload',
      'request',
    ]);
    const responseBody = readNetworkBody(line, maybeJson, ['responseBody', 'response']);
    if (requestBody) result.requestBody = truncate(requestBody, maxPayloadChars);
    if (responseBody) result.responseBody = truncate(responseBody, maxPayloadChars);
  }
}

function includesHeaders(include: NetworkDump['include']): boolean {
  return include === 'headers' || include === 'all';
}

function includesBody(include: NetworkDump['include']): boolean {
  return include === 'body' || include === 'all';
}

function networkEntryKey(entry: NetworkEntry): string {
  return `${entry.timestamp ?? ''}|${entry.method ?? ''}|${entry.url}|${entry.status ?? ''}|${entry.raw}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...<truncated>`;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isInteger(value)
    ? fallback
    : Math.max(min, Math.min(max, value));
}
