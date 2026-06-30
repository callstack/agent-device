import fs from 'node:fs';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const METHOD_WITH_URL_REGEX = new RegExp(`\\b(${HTTP_METHODS.join('|')})\\b\\s+https?:\\/\\/`, 'i');
const URL_REGEX = /https?:\/\/[^\s"'<>\])]+/i;
const STATUS_PATTERNS = [
  /\bstatus(?:Code)?["'=: ]+([1-5]\d{2})\b/i,
  /\bresponse(?:\s+code)?["'=: ]+([1-5]\d{2})\b/i,
  /\bHTTP\/[0-9.]+\s+([1-5]\d{2})\b/i,
];
// When enriching an Android network entry, scan ±5 lines around the match for
// metadata like timestamps, status codes, and packet IDs that Android logcat
// often splits across adjacent log lines.
const ANDROID_NEARBY_LINE_RADIUS = 5;
// For packet-ID correlation, scan a wider ±12-line window because Android's
// OkHttp/Retrofit interceptor logs can spread request→response pairs across
// many interleaved logcat lines.
const ANDROID_PACKET_SCAN_RADIUS = 12;
const NETWORK_LOG_MEMORY_PATH = '<memory>';

import type { NetworkIncludeMode } from '../kernel/contracts.ts';
export type { NetworkIncludeMode };
export type LogBackend = 'ios-simulator' | 'ios-device' | 'android' | 'macos';

export type NetworkEntry = {
  method?: string;
  url: string;
  status?: number;
  timestamp?: string;
  durationMs?: number;
  packetId?: string;
  headers?: string;
  requestBody?: string;
  responseBody?: string;
  raw: string;
  line: number;
};

export type NetworkDump = {
  path: string;
  exists: boolean;
  scannedLines: number;
  matchedLines: number;
  entries: NetworkEntry[];
  include: NetworkIncludeMode;
  limits: {
    maxEntries: number;
    maxPayloadChars: number;
    maxScanLines: number;
  };
};

export function mergeNetworkDumps(
  primary: NetworkDump,
  secondary: NetworkDump,
  maxEntries = primary.limits.maxEntries,
): NetworkDump {
  const entries = [...primary.entries];
  const seen = new Set(entries.map((entry) => networkEntryKey(entry)));
  for (const entry of secondary.entries) {
    const key = networkEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= maxEntries) break;
  }
  return {
    ...primary,
    matchedLines: entries.length,
    entries,
  };
}

export function readRecentNetworkTraffic(
  logPath: string,
  options?: {
    backend?: LogBackend;
    maxEntries?: number;
    include?: NetworkIncludeMode;
    maxPayloadChars?: number;
    maxScanLines?: number;
  },
): NetworkDump {
  const maxEntries = clampInt(options?.maxEntries, 25, 1, 200);
  const include = options?.include ?? 'summary';
  const maxPayloadChars = clampInt(options?.maxPayloadChars, 2048, 64, 16_384);
  const maxScanLines = clampInt(options?.maxScanLines, 4000, 100, 20_000);
  if (!fs.existsSync(logPath)) {
    return {
      path: logPath,
      exists: false,
      scannedLines: 0,
      matchedLines: 0,
      entries: [],
      include,
      limits: { maxEntries, maxPayloadChars, maxScanLines },
    };
  }

  const content = fs.readFileSync(logPath, 'utf8');
  return readRecentNetworkTrafficFromText(content, {
    ...options,
    path: logPath,
  });
}

export function readRecentNetworkTrafficFromText(
  content: string,
  options?: {
    path?: string;
    backend?: LogBackend;
    maxEntries?: number;
    include?: NetworkIncludeMode;
    maxPayloadChars?: number;
    maxScanLines?: number;
  },
): NetworkDump {
  const maxEntries = clampInt(options?.maxEntries, 25, 1, 200);
  const backend = options?.backend;
  const include = options?.include ?? 'summary';
  const maxPayloadChars = clampInt(options?.maxPayloadChars, 2048, 64, 16_384);
  const maxScanLines = clampInt(options?.maxScanLines, 4000, 100, 20_000);
  const allLines = content.split('\n');
  const startIndex = Math.max(0, allLines.length - maxScanLines);
  const lines = allLines.slice(startIndex);
  const entries: NetworkEntry[] = [];

  for (let i = lines.length - 1; i >= 0 && entries.length < maxEntries; i -= 1) {
    const rawLine = lines[i];
    const trimmedLine = rawLine?.trim();
    if (!trimmedLine) continue;
    const parsed = parseNetworkLine(
      lines,
      i,
      startIndex + i + 1,
      backend,
      include,
      maxPayloadChars,
    );
    if (!parsed) continue;
    entries.push(parsed);
  }

  return {
    path: options?.path ?? NETWORK_LOG_MEMORY_PATH,
    exists: true,
    scannedLines: lines.length,
    matchedLines: entries.length,
    entries,
    include,
    limits: { maxEntries, maxPayloadChars, maxScanLines },
  };
}

function parseNetworkLine(
  lines: string[],
  lineIndex: number,
  lineNumber: number,
  backend: LogBackend | undefined,
  include: NetworkIncludeMode,
  maxPayloadChars: number,
): NetworkEntry | null {
  const line = lines[lineIndex]?.trim();
  if (!line) return null;
  const maybeJson = parseEmbeddedJson(line);
  const jsonMethod = readJsonString(maybeJson, ['method', 'httpMethod']);
  const jsonUrl = readJsonString(maybeJson, ['url', 'requestUrl']);
  const jsonStatus = readJsonNumber(maybeJson, ['status', 'statusCode', 'responseCode']);

  const methodWithUrlMatch = METHOD_WITH_URL_REGEX.exec(line);
  const methodFieldMatch = /\bmethod["'=: ]+([A-Z]+)\b/i.exec(line);
  const method = (jsonMethod ?? methodFieldMatch?.[1] ?? methodWithUrlMatch?.[1])?.toUpperCase();

  const urlMatch = URL_REGEX.exec(line);
  const url = jsonUrl ?? urlMatch?.[0];
  if (!url) return null;
  const inlineStatus = jsonStatus ?? parseStatusCode(line) ?? undefined;
  const hasExplicitNetworkSignal =
    Boolean(jsonMethod) ||
    Boolean(methodFieldMatch?.[1]) ||
    Boolean(methodWithUrlMatch?.[1]) ||
    inlineStatus !== undefined ||
    /\bURL["'=: ]+https?:\/\//i.test(line) ||
    /\bheaders?["'=: ]+/i.test(line) ||
    /\b(?:requestBody|responseBody|payload|request|response)["'=: ]+/i.test(line);
  if (!hasExplicitNetworkSignal) {
    return null;
  }

  const result: NetworkEntry = {
    method,
    url,
    status: inlineStatus,
    timestamp: parseTimestamp(line),
    packetId: parseAndroidPacketId(line) ?? undefined,
    durationMs: parseAndroidDurationMs(line) ?? undefined,
    raw: truncate(line, maxPayloadChars),
    line: lineNumber,
  };

  if (backend === 'android') {
    enrichFromAndroidAdjacentLines(result, lines, lineIndex);
  }

  if (include === 'headers' || include === 'all') {
    const headers = readHeaders(line, maybeJson);
    if (headers) {
      result.headers = truncate(headers, maxPayloadChars);
    }
  }

  if (include === 'body' || include === 'all') {
    const requestBody = readBody(line, maybeJson, ['requestBody', 'body', 'payload', 'request']);
    const responseBody = readBody(line, maybeJson, ['responseBody', 'response']);
    if (requestBody) result.requestBody = truncate(requestBody, maxPayloadChars);
    if (responseBody) result.responseBody = truncate(responseBody, maxPayloadChars);
  }

  return result;
}

function networkEntryKey(entry: NetworkEntry): string {
  return `${entry.timestamp ?? ''}|${entry.method ?? ''}|${entry.url}|${entry.status ?? ''}|${entry.raw}`;
}

function enrichFromAndroidAdjacentLines(
  result: NetworkEntry,
  lines: string[],
  lineIndex: number,
): void {
  const nearbyLines = collectNearbyLines(lines, lineIndex, ANDROID_NEARBY_LINE_RADIUS);
  const packetId =
    result.packetId ??
    nearbyLines
      .map((line) => parseAndroidPacketId(line))
      .find((value): value is string => typeof value === 'string' && value.length > 0);
  if (packetId) {
    result.packetId = packetId;
  }

  const relatedLines = packetId
    ? collectNearbyLines(lines, lineIndex, ANDROID_PACKET_SCAN_RADIUS).filter(
        (line) => parseAndroidPacketId(line) === packetId,
      )
    : nearbyLines;
  if (!result.timestamp) {
    result.timestamp = relatedLines
      .map((line) => parseTimestamp(line))
      .find((value): value is string => typeof value === 'string' && value.length > 0);
  }
  if (result.status === undefined) {
    result.status = relatedLines
      .map((line) => parseStatusCode(line))
      .find((value): value is number => typeof value === 'number');
  }
  if (result.durationMs === undefined) {
    result.durationMs = relatedLines
      .map((line) => parseAndroidDurationMs(line))
      .find((value): value is number => typeof value === 'number');
  }
}

function collectNearbyLines(lines: string[], lineIndex: number, radius: number): string[] {
  const collected: string[] = [];
  const start = Math.max(0, lineIndex - radius);
  const end = Math.min(lines.length - 1, lineIndex + radius);
  for (let i = start; i <= end; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    collected.push(line);
  }
  return collected;
}

function parseStatusCode(line: string): number | null {
  for (const pattern of STATUS_PATTERNS) {
    const match = pattern.exec(line);
    if (!match) continue;
    const value = Number.parseInt(match[1] ?? '', 10);
    if (Number.isInteger(value)) return value;
  }
  return null;
}

function parseTimestamp(line: string): string | undefined {
  const isoMatch = /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z)?\b/.exec(line);
  if (isoMatch) return isoMatch[0];
  const androidMatch = /\b\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\b/.exec(line);
  return androidMatch?.[0];
}

function parseAndroidPacketId(line: string): string | null {
  const match = /\bpacket id (\d+)\b/i.exec(line);
  return match?.[1] ?? null;
}

function parseAndroidDurationMs(line: string): number | null {
  const match = /\b(?:duration|elapsed request\/response time, ms)[:= ]+(\d+)\b/i.exec(line);
  if (!match) return null;
  const value = Number.parseInt(match[1] ?? '', 10);
  return Number.isInteger(value) ? value : null;
}

function parseEmbeddedJson(line: string): Record<string, unknown> | null {
  const start = line.indexOf('{');
  if (start < 0) return null;
  const end = line.lastIndexOf('}');
  if (end <= start) return null;
  const candidate = line.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readJsonString(value: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const next = value[key];
    if (typeof next === 'string' && next.trim().length > 0) {
      return next.trim();
    }
  }
  return undefined;
}

function readJsonNumber(value: Record<string, unknown> | null, keys: string[]): number | null {
  if (!value) return null;
  for (const key of keys) {
    const next = value[key];
    if (typeof next === 'number' && Number.isInteger(next)) return next;
    if (typeof next === 'string' && /^\d{3}$/.test(next.trim())) {
      return Number.parseInt(next.trim(), 10);
    }
  }
  return null;
}

function readHeaders(line: string, json: Record<string, unknown> | null): string | undefined {
  if (json) {
    const headers = json.headers ?? json.requestHeaders ?? json.responseHeaders;
    if (headers !== undefined) return stringifyValue(headers);
  }
  const match = /\bheaders?["'=: ]+(\{.*\})/i.exec(line);
  return match?.[1]?.trim();
}

function readBody(
  line: string,
  json: Record<string, unknown> | null,
  jsonKeys: string[],
): string | undefined {
  if (json) {
    for (const key of jsonKeys) {
      if (json[key] !== undefined) return stringifyValue(json[key]);
    }
  }
  for (const key of jsonKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}["'=: ]+(.+)$`, 'i');
    const match = regex.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...<truncated>`;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
