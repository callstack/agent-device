import type {
  BackendDumpNetworkResult,
  BackendMeasurePerfResult,
  BackendNetworkIncludeMode,
  BackendReadLogsResult,
} from '../../../backend.ts';
import type {
  DiagnosticsLogsCommandResult,
  DiagnosticsNetworkCommandResult,
  DiagnosticsPerfCommandResult,
} from './diagnostics-types.ts';
import {
  redactNetworkLogText as redactText,
  redactNetworkUrl,
} from '../../../kernel/observability-redaction.ts';

const PAYLOAD_MAX_CHARS = 2048;
const MESSAGE_MAX_CHARS = 4096;
const SECRET_KEY_PATTERN = /(?:authorization|cookie|token|secret|password|passwd|api[-_]?key)/i;

export function formatLogsResult(result: BackendReadLogsResult): DiagnosticsLogsCommandResult {
  let redacted = result.redacted === true;
  const entries = result.entries.map((entry) => {
    const message = redactAndTruncate(entry.message, MESSAGE_MAX_CHARS);
    const metadata = redactUnknown(entry.metadata);
    redacted ||= message.redacted || metadata.redacted;
    return {
      ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      ...(entry.level ? { level: entry.level } : {}),
      message: message.value ?? '',
      ...(entry.source ? { source: entry.source } : {}),
      ...(metadata.value ? { metadata: metadata.value as Record<string, unknown> } : {}),
    };
  });
  return {
    kind: 'diagnosticsLogs',
    entries,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    ...(result.timeWindow ? { timeWindow: result.timeWindow } : {}),
    ...(result.backend ? { backend: result.backend } : {}),
    redacted,
    ...(result.notes ? { notes: result.notes } : {}),
  };
}

export function formatNetworkResult(
  result: BackendDumpNetworkResult,
  include: BackendNetworkIncludeMode,
): DiagnosticsNetworkCommandResult {
  let redacted = result.redacted === true;
  // fallow-ignore-next-line complexity
  const entries = result.entries.map((entry) => {
    const url = entry.url ? redactUrl(entry.url) : undefined;
    const requestHeaders =
      include === 'headers' || include === 'all' ? redactHeaders(entry.requestHeaders) : undefined;
    const responseHeaders =
      include === 'headers' || include === 'all' ? redactHeaders(entry.responseHeaders) : undefined;
    const requestBody =
      include === 'body' || include === 'all' ? redactPayload(entry.requestBody) : undefined;
    const responseBody =
      include === 'body' || include === 'all' ? redactPayload(entry.responseBody) : undefined;
    const metadata = redactUnknown(entry.metadata);
    redacted ||=
      (url?.redacted ?? false) ||
      (requestHeaders?.redacted ?? false) ||
      (responseHeaders?.redacted ?? false) ||
      (requestBody?.redacted ?? false) ||
      (responseBody?.redacted ?? false) ||
      metadata.redacted;
    return {
      ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      ...(entry.method ? { method: entry.method } : {}),
      ...(url ? { url: url.value } : {}),
      ...(entry.status !== undefined ? { status: entry.status } : {}),
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      ...(requestHeaders?.value ? { requestHeaders: requestHeaders.value } : {}),
      ...(responseHeaders?.value ? { responseHeaders: responseHeaders.value } : {}),
      ...(requestBody?.value !== undefined ? { requestBody: requestBody.value } : {}),
      ...(responseBody?.value !== undefined ? { responseBody: responseBody.value } : {}),
      ...(metadata.value ? { metadata: metadata.value as Record<string, unknown> } : {}),
    };
  });
  return {
    kind: 'diagnosticsNetwork',
    entries,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    ...(result.timeWindow ? { timeWindow: result.timeWindow } : {}),
    ...(result.backend ? { backend: result.backend } : {}),
    redacted,
    ...(result.notes ? { notes: result.notes } : {}),
  };
}

export function formatPerfResult(result: BackendMeasurePerfResult): DiagnosticsPerfCommandResult {
  let redacted = result.redacted === true;
  return {
    kind: 'diagnosticsPerf',
    metrics: result.metrics.map((metric) => {
      const message = redactAndTruncate(metric.message, MESSAGE_MAX_CHARS);
      const metadata = redactUnknown(metric.metadata);
      redacted ||= message.redacted || metadata.redacted;
      return {
        name: metric.name,
        ...(metric.value !== undefined ? { value: metric.value } : {}),
        ...(metric.unit ? { unit: metric.unit } : {}),
        ...(metric.status ? { status: metric.status } : {}),
        ...(message.value !== undefined ? { message: message.value } : {}),
        ...(metadata.value ? { metadata: metadata.value as Record<string, unknown> } : {}),
      };
    }),
    ...(result.startedAt ? { startedAt: result.startedAt } : {}),
    ...(result.endedAt ? { endedAt: result.endedAt } : {}),
    ...(result.backend ? { backend: result.backend } : {}),
    redacted,
    ...(result.notes ? { notes: result.notes } : {}),
  };
}

function redactHeaders(headers: Record<string, string> | undefined): {
  value?: Record<string, string>;
  redacted: boolean;
} {
  if (!headers) return { redacted: false };
  let redacted = false;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      next[key] = '[REDACTED]';
      redacted = true;
    } else {
      const result = redactAndTruncate(value, PAYLOAD_MAX_CHARS);
      next[key] = result.value ?? '';
      redacted ||= result.redacted;
    }
  }
  return { value: next, redacted };
}

function redactUrl(url: string): { value: string; redacted: boolean } {
  return (
    redactNetworkUrl(url) ??
    (redactAndTruncate(url, PAYLOAD_MAX_CHARS) as { value: string; redacted: boolean })
  );
}

function redactPayload(value: string | undefined): { value?: string; redacted: boolean } {
  if (value === undefined) return { redacted: false };
  const structured = redactJsonPayload(value);
  return structured ?? redactAndTruncate(value, PAYLOAD_MAX_CHARS);
}

function redactJsonPayload(value: string): { value?: string; redacted: boolean } | undefined {
  try {
    const parsed = JSON.parse(value);
    const result = redactValue(parsed, redactText);
    return truncateRedacted(JSON.stringify(result.value), PAYLOAD_MAX_CHARS, result.redacted);
  } catch {
    return undefined;
  }
}

function redactUnknown(value: unknown): { value?: unknown; redacted: boolean } {
  return redactValue(value, (entry) => redactAndTruncate(entry, PAYLOAD_MAX_CHARS));
}

function redactValue(
  value: unknown,
  redactString: (value: string) => { value?: string; redacted: boolean },
): { value?: unknown; redacted: boolean } {
  if (value === undefined) return { redacted: false };
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return { value, redacted: false };
  if (Array.isArray(value)) {
    let redacted = false;
    const next = value.map((entry) => {
      const result = redactValue(entry, redactString);
      redacted ||= result.redacted;
      return result.value;
    });
    return { value: next, redacted };
  }
  let redacted = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      next[key] = '[REDACTED]';
      redacted = true;
      continue;
    }
    const result = redactValue(entry, redactString);
    next[key] = result.value;
    redacted ||= result.redacted;
  }
  return { value: next, redacted };
}

function redactAndTruncate(
  value: string | undefined,
  maxChars: number,
): { value?: string; redacted: boolean } {
  if (value === undefined) return { redacted: false };
  const result = redactText(value);
  return truncateRedacted(result.value, maxChars, result.redacted);
}

function truncateRedacted(
  value: string | undefined,
  maxChars: number,
  redacted: boolean,
): { value?: string; redacted: boolean } {
  if (value === undefined) return { redacted };
  let next = value;
  if (next.length > maxChars) {
    next = `${next.slice(0, maxChars)}...[truncated]`;
    redacted = true;
  }
  return { value: next, redacted };
}
