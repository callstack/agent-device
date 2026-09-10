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
const CFNETWORK_CONNECTION_URL = /\[C(\d+)\b[^\]]*?\burl:\s*([^\s,\]]+)/;
const CFNETWORK_TASK_SUMMARY = /\bsummary for task (?:success|failure)\s*\{([^}]*)\}/;
// `Task <UUID>.<seq>` identifies one request across every line it appears on,
// so the same request seen in two scan windows reconciles to one.
const CFNETWORK_TASK_ID = /\bTask\s+<([0-9A-Fa-f-]+)>\.<(\d+)>/;
// `name[pid:tid]` in the compact unified-log prefix. Connection numbers restart
// per process, so a number alone would let a relaunched app inherit the origin
// its predecessor opened; the pid is what keeps those apart.
const LOG_PROCESS_IDENTITY = /(?:^|\s)(\S+)\[(\d+):[0-9a-f]+\]/;
// `url: <value>,` is a delimited field, so the separator belongs to the format
// rather than to the URL. A bare URL elsewhere keeps whatever it matched, since
// nothing there establishes that trailing punctuation is not part of the path.
const URL_FIELD = /\burl:\s*(https?:\/\/[^\s,\]]+)/i;

/** Connection openings in scan order, so a recycled number resolves to its most recent opening. */
type CfNetworkConnectionIndex = ReadonlyMap<
  string,
  readonly Readonly<{ lineIndex: number; origin: string }>[]
>;

/**
 * A dump plus the identities behind its `unnamedRequests`. Reconciling two scan
 * windows needs those identities; a caller returning a dump to its requester
 * does not, and an unbounded list of them has no place in a response.
 */
export type ScannedNetworkDump = NetworkDump & Readonly<{ unnamedRequestIds?: readonly string[] }>;

/** The public projection: identities dropped, their count kept. */
export function withoutScanIdentities(dump: ScannedNetworkDump): NetworkDump {
  const { unnamedRequestIds: _identities, ...rest } = dump;
  return Object.freeze(rest);
}

export function mergeNetworkDumps(
  primary: ScannedNetworkDump,
  secondary: ScannedNetworkDump,
  maxEntries = primary.limits.maxEntries,
): ScannedNetworkDump {
  const entries = [...primary.entries];
  const seen = new Set(entries.map(networkEntryKey));
  for (const entry of secondary.entries) {
    const key = networkEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= maxEntries) break;
  }
  // The two windows can cover different, overlapping, or disjoint traffic. A
  // request either window named is named, and the rest union by identity, so
  // neither window's blind spot inflates or masks the other's.
  const named = new Set(
    [...primary.entries, ...secondary.entries]
      .map((entry) => entry.packetId)
      .filter((id): id is string => id !== undefined),
  );
  const unnamedRequestIds = [
    ...new Set([...(primary.unnamedRequestIds ?? []), ...(secondary.unnamedRequestIds ?? [])]),
  ].filter((id) => !named.has(id));
  return Object.freeze({
    ...primary,
    matchedLines: entries.length,
    entries: Object.freeze(entries),
    unnamedRequests: unnamedRequestIds.length,
    unnamedRequestIds: Object.freeze(unnamedRequestIds),
  });
}

export function readRecentNetworkTrafficFromText(
  content: string,
  options: NetworkDumpParserOptions,
): ScannedNetworkDump {
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
      unnamedRequests: 0,
      include,
      limits: Object.freeze({ maxEntries, maxPayloadChars, maxScanLines }),
    });
  }
  const allLines = content.split('\n');
  const startIndex = Math.max(0, allLines.length - maxScanLines);
  const lines = allLines.slice(startIndex);
  const entries: NetworkEntry[] = [];
  const cfNetworkConnections = isAppleBackend(options.backend)
    ? indexCfNetworkConnections(lines)
    : undefined;
  const unnamedRequestIds = cfNetworkConnections
    ? collectUnnamedCfNetworkTasks(lines, cfNetworkConnections)
    : [];
  for (let i = lines.length - 1; i >= 0 && entries.length < maxEntries; i -= 1) {
    if (!lines[i]?.trim()) continue;
    const parsed = parseNetworkLine(
      lines,
      i,
      lineNumberOffset + startIndex + i + 1,
      options.backend,
      include,
      maxPayloadChars,
      cfNetworkConnections,
    );
    if (parsed) entries.push(parsed);
  }
  return Object.freeze({
    path: options.path,
    exists: true,
    scannedLines: lines.length,
    matchedLines: entries.length,
    entries: Object.freeze(entries),
    unnamedRequests: unnamedRequestIds.length,
    unnamedRequestIds: Object.freeze(unnamedRequestIds),
    include,
    limits: Object.freeze({ maxEntries, maxPayloadChars, maxScanLines }),
  });
}

function isAppleBackend(backend: LogBackend | undefined): boolean {
  return backend === 'ios-simulator' || backend === 'ios-device' || backend === 'macos';
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
  cfNetworkConnections: CfNetworkConnectionIndex | undefined,
): NetworkEntry | null {
  const line = lines[lineIndex]?.trim();
  if (!line) return null;
  const maybeJson = parseEmbeddedNetworkJson(line);
  const identity =
    parseNetworkIdentity(line, maybeJson) ??
    (cfNetworkConnections
      ? parseCfNetworkReusedTaskIdentity(line, cfNetworkConnections, lineIndex)
      : null);
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
  durationMs?: number;
  pathUnavailable?: boolean;
  packetId?: string;
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
  const json = readNetworkJsonString(maybeJson, ['url', 'requestUrl']);
  if (json) return json;
  return URL_FIELD.exec(line)?.[1] ?? URL_REGEX.exec(line)?.[0];
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
    packetId: identity.packetId ?? parseAndroidPacketId(line) ?? undefined,
    durationMs: identity.durationMs ?? parseAndroidDurationMs(line) ?? undefined,
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

/**
 * CFNetwork logs a request URL only on the `com.apple.network:connection` line
 * that opens a connection. A request that reuses a keep-alive connection emits
 * a task summary with status, timing, and byte counts but no URL anywhere, so
 * a URL-keyed reader drops it and an "endpoint was never called" check reads as
 * a definite negative. Resolving the summary against the connection it reused
 * recovers the origin; the request path is not in the log at all.
 */
function indexCfNetworkConnections(lines: readonly string[]): CfNetworkConnectionIndex {
  const index = new Map<string, { lineIndex: number; origin: string }[]>();
  for (const [lineIndex, line] of lines.entries()) {
    const match = CFNETWORK_CONNECTION_URL.exec(line);
    if (!match) continue;
    const key = cfNetworkConnectionKey(line, match[1] as string);
    const origin = key === undefined ? undefined : readCfNetworkOrigin(match[2] as string);
    if (!origin || key === undefined) continue;
    const openings = index.get(key);
    if (openings) openings.push({ lineIndex, origin });
    else index.set(key, [{ lineIndex, origin }]);
  }
  return index;
}

/**
 * A connection is only the same connection within one process. A line whose
 * process cannot be read correlates to nothing, so its traffic stays unnamed
 * rather than borrowing an origin the app never contacted.
 */
function cfNetworkConnectionKey(line: string, connection: string): string | undefined {
  const process = LOG_PROCESS_IDENTITY.exec(line);
  if (!process) return undefined;
  return `${process[1]}[${process[2]}]#${connection}`;
}

function parseCfNetworkReusedTaskIdentity(
  line: string,
  index: CfNetworkConnectionIndex,
  lineIndex: number,
): NetworkIdentity | null {
  const summary = CFNETWORK_TASK_SUMMARY.exec(line);
  if (!summary) return null;
  const fields = readCfNetworkSummaryFields(summary[1] as string);
  // Without `reused` the task opened its own connection, so a URL-bearing line
  // for it is already in the log and this summary would only duplicate it.
  if (fields.get('reused') !== '1') return null;
  const connection = fields.get('connection');
  const key = connection === undefined ? undefined : cfNetworkConnectionKey(line, connection);
  const origin = key === undefined ? undefined : resolveCfNetworkOrigin(index, key, lineIndex);
  if (!origin) return null;
  return {
    url: origin,
    status: readCfNetworkStatus(fields.get('response_status')),
    durationMs: readCfNetworkCount(fields.get('transaction_duration_ms')),
    pathUnavailable: true,
    packetId: cfNetworkTaskId(line),
  };
}

function collectUnnamedCfNetworkTasks(
  lines: readonly string[],
  index: CfNetworkConnectionIndex,
): string[] {
  const unnamed = new Set<string>();
  for (const [lineIndex, line] of lines.entries()) {
    const task = unnamedCfNetworkTaskOn(line, index, lineIndex);
    if (task !== undefined) unnamed.add(task);
  }
  return [...unnamed];
}

/** The identity of a reused task on this line that resolves to no origin. */
function unnamedCfNetworkTaskOn(
  line: string,
  index: CfNetworkConnectionIndex,
  lineIndex: number,
): string | undefined {
  if (!line.includes('summary for task')) return undefined;
  const summary = CFNETWORK_TASK_SUMMARY.exec(line);
  if (!summary) return undefined;
  const fields = readCfNetworkSummaryFields(summary[1] as string);
  if (fields.get('reused') !== '1') return undefined;
  const connection = fields.get('connection');
  const key = connection === undefined ? undefined : cfNetworkConnectionKey(line, connection);
  if (key !== undefined && resolveCfNetworkOrigin(index, key, lineIndex)) return undefined;
  return cfNetworkTaskId(line);
}

/** One request's identity, scoped to its process so a relaunch cannot alias it. */
function cfNetworkTaskId(line: string): string | undefined {
  const task = CFNETWORK_TASK_ID.exec(line);
  if (!task) return undefined;
  const process = LOG_PROCESS_IDENTITY.exec(line);
  const scope = process ? `${process[1]}[${process[2]}]` : '';
  return `${scope}#${task[1]}.${task[2]}`;
}

function resolveCfNetworkOrigin(
  index: CfNetworkConnectionIndex,
  key: string,
  lineIndex: number,
): string | undefined {
  const openings = index.get(key);
  if (!openings) return undefined;
  let resolved: string | undefined;
  for (const opening of openings) {
    if (opening.lineIndex > lineIndex) break;
    resolved = opening.origin;
  }
  return resolved;
}

function readCfNetworkSummaryFields(body: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const pair of body.split(',')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    fields.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return fields;
}

function readCfNetworkOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

// CFNetwork reports `-1` for a task that never received a response status.
function readCfNetworkStatus(value: string | undefined): number | undefined {
  const status = readCfNetworkCount(value);
  return status !== undefined && status > 0 ? status : undefined;
}

function readCfNetworkCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
