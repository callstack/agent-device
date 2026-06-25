import type { BackendNetworkEntry } from '../../backend.ts';
import type { NetworkIncludeMode } from '../../kernel/contracts.ts';
import type { NetworkEntry } from '../../daemon/network-log.ts';
import type { CliOutput } from '../command-contract.ts';
import { resultOutput, type CliOutputFormatter } from '../output-common.ts';

type LogsActionFields = {
  started?: true;
  stopped?: true;
  marked?: true;
  cleared?: true;
  restarted?: true;
  removedRotatedFiles?: number;
};

type LogsCliResult = LogsActionFields & {
  path: string;
  active?: boolean;
  state?: string;
  backend?: string;
  sizeBytes?: number;
  hint?: string;
  notes?: readonly string[];
};

const LOG_ACTION_FIELD_KEYS = [
  'started',
  'stopped',
  'marked',
  'cleared',
  'restarted',
  'removedRotatedFiles',
] as const satisfies readonly (keyof LogsActionFields)[];

type NetworkCliEntry = (BackendNetworkEntry | NetworkEntry) & {
  headers?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
};

type NetworkCliResult = {
  path?: string;
  active?: boolean;
  state?: string;
  backend?: string;
  include?: NetworkIncludeMode;
  scannedLines?: number;
  matchedLines?: number;
  entries?: readonly NetworkCliEntry[];
  notes?: readonly string[];
};

type AudioCliResult = {
  active?: boolean;
  backend?: string;
  source?: string;
  state?: string;
  heard?: boolean;
  durationMs?: number;
  elapsedMs?: number;
  bucketMs?: number;
  sampleCount?: number;
  sourceCount?: number;
  mediaElementCount?: number;
  rmsDbfs?: readonly number[];
  peakDbfs?: readonly number[];
  notes?: readonly string[];
};

function logsCliOutput(data: LogsCliResult): CliOutput {
  return {
    data,
    text: data.path,
    stderr: joinDefinedLines([
      formatKeyValueFields(data, ['active', 'state', 'backend', 'sizeBytes'] as const),
      formatActionFields(data),
      data.hint,
      formatNotes(data.notes),
    ]),
  };
}

function networkCliOutput(data: NetworkCliResult): CliOutput {
  const lines: string[] = [];
  const entries = data.entries ?? [];
  if (data.path) lines.push(data.path);
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
      ] as const),
      formatNotes(data.notes),
    ]),
  };
}

function audioCliOutput(data: AudioCliResult): CliOutput {
  const lines = [
    `Audio probe: ${String(data.state ?? 'stopped')} heard=${String(data.heard === true)}`,
    formatAudioArray('rmsDbfs', data.rmsDbfs),
    formatAudioArray('peakDbfs', data.peakDbfs),
  ].filter((line): line is string => Boolean(line));
  return {
    data,
    text: lines.join('\n'),
    stderr: joinDefinedLines([
      formatKeyValueFields(data, [
        'active',
        'backend',
        'source',
        'durationMs',
        'elapsedMs',
        'bucketMs',
        'sampleCount',
        'sourceCount',
        'mediaElementCount',
      ] as const),
      formatNotes(data.notes),
    ]),
  };
}

export const observabilityCliOutputFormatters = {
  logs: resultOutput<LogsCliResult>(logsCliOutput),
  network: resultOutput<NetworkCliResult>(networkCliOutput),
  audio: resultOutput<AudioCliResult>(audioCliOutput),
} as const satisfies Record<string, CliOutputFormatter>;

function formatAudioArray(label: string, value: readonly number[] | undefined): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter(
    (item): item is number => typeof item === 'number' && Number.isFinite(item),
  );
  return numbers.length > 0 ? `${label}: [${numbers.join(', ')}]` : undefined;
}

function formatActionFields(data: LogsActionFields): string | undefined {
  return (
    LOG_ACTION_FIELD_KEYS.map((key) => formatActionField(key, data[key]))
      .filter(Boolean)
      .join(' ') || undefined
  );
}

function formatActionField(key: string, value: true | number | null | undefined): string {
  return value == null ? '' : `${key}=${value}`;
}

function formatNetworkEntry(entry: NetworkCliEntry): string[] {
  const method = entry.method ?? 'HTTP';
  const url = entry.url ?? '<unknown-url>';
  const status = entry.status !== undefined ? ` status=${entry.status}` : '';
  const timestamp = entry.timestamp ? `${entry.timestamp} ` : '';
  const durationMs = entry.durationMs !== undefined ? ` durationMs=${entry.durationMs}` : '';
  const lines = [`${timestamp}${method} ${url}${status}${durationMs}`];
  if (entry.headers) {
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

function formatKeyValueFields<T extends object, K extends Extract<keyof T, string>>(
  data: T,
  fields: readonly K[],
): string | undefined {
  const text = fields
    .map((key) => (data[key] !== undefined && data[key] !== null ? `${key}=${data[key]}` : ''))
    .filter(Boolean)
    .join(' ');
  return text || undefined;
}

function formatNotes(notes: readonly string[] | undefined): string | undefined {
  const lines = notes?.filter((note) => note.length > 0) ?? [];
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function joinDefinedLines(lines: Array<string | undefined>): string | undefined {
  const joined = lines.filter((line): line is string => Boolean(line)).join('\n');
  return joined || undefined;
}
