import type { CommandRequestResult } from '../../client-types.ts';
import type { BackendNetworkEntry } from '../../backend.ts';
import type { NetworkEntry } from '../../daemon/network-log.ts';
import type { CliOutput } from '../command-contract.ts';
import { resultOutput, type CliOutputFormatter } from '../output-common.ts';

type NetworkCliEntry = (BackendNetworkEntry | NetworkEntry) & {
  headers?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
};

type NetworkCliResult = Record<string, unknown> & {
  path?: string;
  entries: readonly NetworkCliEntry[];
  notes?: readonly string[];
};

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

function networkCliOutput(data: NetworkCliResult): CliOutput {
  const lines: string[] = [];
  if (data.path) lines.push(data.path);
  if (data.entries.length === 0) {
    lines.push('No recent HTTP(s) entries found.');
  } else {
    for (const entry of data.entries) {
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
  network: resultOutput<NetworkCliResult>(networkCliOutput),
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

function formatNetworkEntry(entry: NetworkCliEntry): string[] {
  const method = entry.method ?? 'HTTP';
  const url = entry.url ?? '<unknown-url>';
  const status = entry.status !== undefined ? ` status=${entry.status}` : '';
  const timestamp = entry.timestamp ? `${entry.timestamp} ` : '';
  const durationMs = entry.durationMs !== undefined ? ` durationMs=${entry.durationMs}` : '';
  const lines = [`${timestamp}${method} ${url}${status}${durationMs}`];
  if ('headers' in entry && entry.headers) {
    appendNetworkEntryBody(lines, 'headers', entry.headers);
  } else {
    appendNetworkEntryHeaders(lines, 'request headers', entry.requestHeaders);
    appendNetworkEntryHeaders(lines, 'response headers', entry.responseHeaders);
  }
  appendNetworkEntryBody(lines, 'request', entry.requestBody);
  appendNetworkEntryBody(lines, 'response', entry.responseBody);
  return lines;
}

function appendNetworkEntryHeaders(
  lines: string[],
  label: string,
  headers: Record<string, string> | undefined,
): void {
  if (!headers || Object.keys(headers).length === 0) return;
  lines.push(`  ${label}: ${JSON.stringify(headers)}`);
}

function appendNetworkEntryBody(lines: string[], label: string, value: string | undefined): void {
  if (value !== undefined) lines.push(`  ${label}: ${value}`);
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
