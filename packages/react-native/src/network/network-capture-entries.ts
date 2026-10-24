import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';
import type { NetworkProviderEntry } from '@agent-device/contracts/network-runtime';
import { redactDiagnosticData, redactNetworkPayload } from '@agent-device/kernel/redaction';
import { NETWORK_CAPTURE_MAX_ENTRIES } from './network-capture-runtime.ts';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') headers[name] = entry;
  }
  return Object.keys(headers).length > 0
    ? (redactDiagnosticData(headers) as Record<string, string>)
    : undefined;
}

/** Metadata a drained entry earns beyond its request fields: the transport it ran on, its error. */
function readMetadata(
  entry: Record<string, unknown>,
  maxPayloadChars: number,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  const transport = readString(entry.transport);
  if (transport) metadata.transport = transport;
  const error = readString(entry.error);
  if (error) metadata.error = redactNetworkPayload(error, maxPayloadChars);
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function detailFields(
  entry: Record<string, unknown>,
  include: NetworkIncludeMode,
  maxPayloadChars: number,
): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  if (includesHeaders(include)) {
    const requestHeaders = readHeaders(entry.requestHeaders);
    const responseHeaders = readHeaders(entry.responseHeaders);
    if (requestHeaders) detail.requestHeaders = requestHeaders;
    if (responseHeaders) detail.responseHeaders = responseHeaders;
  }
  if (includesBody(include)) {
    const requestBody = readString(entry.requestBody);
    const responseBody = readString(entry.responseBody);
    if (requestBody !== undefined)
      detail.requestBody = redactNetworkPayload(requestBody, maxPayloadChars);
    if (responseBody !== undefined)
      detail.responseBody = redactNetworkPayload(responseBody, maxPayloadChars);
  }
  return detail;
}

/**
 * Projects the raw entries one app runtime drained into the provider dump shape the
 * `network dump` response carries. Each entry crosses the debugger boundary as untrusted JSON, so
 * every field is read defensively. The newest entry comes first. Header and body detail rides
 * along only as `include` asks for; header values and bodies are redacted with the shared secret
 * rules and bounded to `maxPayloadChars`. The captured URL stays verbatim: the full URL is the
 * reason the in-app capture exists.
 */
export function projectCapturedNetworkEntries(
  entries: readonly unknown[],
  include: NetworkIncludeMode,
  maxPayloadChars: number,
): readonly NetworkProviderEntry[] {
  const projected: NetworkProviderEntry[] = [];
  for (const value of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const url = readString(entry.url);
    if (url === undefined) continue;
    const metadata = readMetadata(entry, maxPayloadChars);
    projected.push({
      timestamp: readString(entry.timestamp),
      method: readString(entry.method),
      url,
      status: readNumber(entry.status),
      durationMs: readNumber(entry.durationMs),
      ...detailFields(entry, include, maxPayloadChars),
      ...(metadata ? { metadata } : {}),
    });
  }
  return projected.reverse();
}

export type CaptureStats = Readonly<{
  buffered: number | undefined;
  dropped: number;
}>;

/** Notes the buffer's own accounting earns: what stays buffered, what the ring evicted. */
export function captureBufferNotes(stats: CaptureStats): readonly string[] {
  const notes: string[] = [];
  if (stats.buffered !== undefined && stats.buffered > 0) {
    notes.push(
      `${stats.buffered} older captured request${stats.buffered === 1 ? '' : 's'} remain buffered; dump again or raise the limit.`,
    );
  }
  if (stats.dropped > 0) {
    notes.push(
      `${stats.dropped} captured request${stats.dropped === 1 ? '' : 's'} were evicted from the ${NETWORK_CAPTURE_MAX_ENTRIES}-entry app buffer before this dump.`,
    );
  }
  return notes;
}

function includesHeaders(include: NetworkIncludeMode): boolean {
  return include === 'headers' || include === 'all';
}

function includesBody(include: NetworkIncludeMode): boolean {
  return include === 'body' || include === 'all';
}
