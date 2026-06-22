import type { CommandRequestResult } from '../../client-types.ts';
import type { CliOutput } from '../command-contract.ts';
import { readRecord, resultOutput, type CliOutputFormatter } from '../output-common.ts';

function logsCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  const pathOut = typeof data.path === 'string' ? data.path : '';
  return {
    data,
    text: pathOut,
    stderr: joinDefinedLines([
      formatKeyValueFields(data, ['active', 'state', 'backend', 'sizeBytes']),
      formatActionFields(data),
      typeof data.hint === 'string' ? data.hint : undefined,
      formatNotes(data.notes),
    ]),
  };
}

function networkCliOutput(result: CommandRequestResult): CliOutput {
  const data = result as Record<string, unknown>;
  const lines: string[] = [];
  const pathOut = typeof data.path === 'string' ? data.path : '';
  if (pathOut) lines.push(pathOut);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (entries.length === 0) {
    lines.push('No recent HTTP(s) entries found.');
  } else {
    for (const entry of entries) {
      lines.push(...formatNetworkEntry(entry));
    }
  }
  return {
    data,
    text: lines.join('\n'),
    stderr: joinDefinedLines([
      formatKeyValueFields(data, [
        'active',
        'state',
        'backend',
        'include',
        'scannedLines',
        'matchedLines',
      ]),
      formatNotes(data.notes),
    ]),
  };
}

export const observabilityCliOutputFormatters = {
  logs: resultOutput(logsCliOutput),
  network: resultOutput(networkCliOutput),
} as const satisfies Record<string, CliOutputFormatter>;

function formatActionFields(data: Record<string, unknown>): string | undefined {
  return (
    ['started', 'stopped', 'marked', 'cleared', 'restarted', 'removedRotatedFiles']
      .map((key) => formatActionField(key, data[key]))
      .filter(Boolean)
      .join(' ') || undefined
  );
}

function formatActionField(key: string, value: unknown): string {
  if (value === true) return `${key}=true`;
  return typeof value === 'number' ? `${key}=${value}` : '';
}

function formatNetworkEntry(entry: unknown): string[] {
  const record = readRecord(entry) ?? {};
  const method = typeof record.method === 'string' ? record.method : 'HTTP';
  const url = typeof record.url === 'string' ? record.url : '<unknown-url>';
  const status = typeof record.status === 'number' ? ` status=${record.status}` : '';
  const timestamp = typeof record.timestamp === 'string' ? `${record.timestamp} ` : '';
  const durationMs =
    typeof record.durationMs === 'number' ? ` durationMs=${record.durationMs}` : '';
  const lines = [`${timestamp}${method} ${url}${status}${durationMs}`];
  const hasFormattedHeaders = typeof record.headers === 'string';
  appendNetworkEntryBody(lines, 'headers', record.headers);
  if (!hasFormattedHeaders) {
    appendNetworkEntryHeaders(lines, 'request headers', record.requestHeaders);
    appendNetworkEntryHeaders(lines, 'response headers', record.responseHeaders);
  }
  appendNetworkEntryBody(lines, 'request', record.requestBody);
  appendNetworkEntryBody(lines, 'response', record.responseBody);
  return lines;
}

function appendNetworkEntryHeaders(lines: string[], label: string, value: unknown): void {
  const headers = readRecord(value);
  if (!headers || Object.keys(headers).length === 0) return;
  lines.push(`  ${label}: ${JSON.stringify(headers)}`);
}

function appendNetworkEntryBody(lines: string[], label: string, value: unknown): void {
  if (typeof value === 'string') lines.push(`  ${label}: ${value}`);
}

function formatKeyValueFields(data: Record<string, unknown>, fields: string[]): string | undefined {
  const text = fields
    .map((key) => (data[key] !== undefined && data[key] !== null ? `${key}=${data[key]}` : ''))
    .filter(Boolean)
    .join(' ');
  return text || undefined;
}

function formatNotes(notes: unknown): string | undefined {
  if (!Array.isArray(notes)) return undefined;
  const lines = notes.filter((note): note is string => typeof note === 'string' && note.length > 0);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function joinDefinedLines(lines: Array<string | undefined>): string | undefined {
  const joined = lines.filter((line): line is string => Boolean(line)).join('\n');
  return joined || undefined;
}
