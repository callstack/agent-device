import type {
  BackendDumpNetworkOptions,
  BackendDumpNetworkResult,
  BackendNetworkEntry,
} from '../../backend.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import { isJsonObject, readNumberProperty, readStringProperty } from './json-utils.ts';

type AgentBrowserNetworkRequest = {
  headers?: Record<string, string>;
  method?: string;
  mimeType?: string;
  requestId?: string;
  resourceType?: string;
  responseHeaders?: Record<string, string>;
  status?: number;
  timestamp?: number | string;
  url?: string;
};

export function normalizeAgentBrowserNetworkRequests(
  data: unknown,
  options: BackendDumpNetworkOptions = {},
): BackendDumpNetworkResult {
  const requests = readRequests(data);
  const limit = clampLimit(options.limit);
  const includeHeaders = options.include === 'headers' || options.include === 'all';
  const entries = requests
    .slice(-limit)
    .reverse()
    .map((request) => toBackendNetworkEntry(request, includeHeaders));
  const notes =
    options.include === 'body' || options.include === 'all'
      ? ['agent-browser network requests does not expose request or response bodies.']
      : undefined;
  return {
    entries,
    backend: 'agent-browser',
    redacted: false,
    ...(notes ? { notes } : {}),
  };
}

function readRequests(data: unknown): AgentBrowserNetworkRequest[] {
  const value = isJsonObject(data) && Array.isArray(data.requests) ? data.requests : data;
  if (!Array.isArray(value)) return [];
  return value.filter(isAgentBrowserNetworkRequest).map((entry) => ({
    headers: readStringRecord(entry.headers),
    method: readStringProperty(entry, 'method'),
    mimeType: readStringProperty(entry, 'mimeType'),
    requestId: readStringProperty(entry, 'requestId'),
    resourceType: readStringProperty(entry, 'resourceType'),
    responseHeaders: readStringRecord(entry.responseHeaders),
    status: readNumberProperty(entry, 'status'),
    timestamp: readTimestampInput(entry.timestamp),
    url: readStringProperty(entry, 'url'),
  }));
}

function isAgentBrowserNetworkRequest(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value);
}

function toBackendNetworkEntry(
  request: AgentBrowserNetworkRequest,
  includeHeaders: boolean,
): BackendNetworkEntry {
  const timestamp =
    request.timestamp === undefined ? undefined : normalizeTimestamp(request.timestamp);
  const metadata = stripUndefined({
    requestId: request.requestId,
    resourceType: request.resourceType,
    mimeType: request.mimeType,
  });
  return stripUndefined({
    timestamp,
    method: request.method,
    url: request.url,
    status: request.status,
    requestHeaders: includeHeaders ? request.headers : undefined,
    responseHeaders: includeHeaders ? request.responseHeaders : undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isJsonObject(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function readTimestampInput(value: unknown): number | string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return value;
  return undefined;
}

function normalizeTimestamp(value: number | string): string {
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return value;
    return normalizeTimestamp(numeric);
  }
  const timestamp = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 25;
  const limit = value;
  return Math.max(1, Math.min(limit, 200));
}
