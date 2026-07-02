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

type EventsCliEntry = {
  ts?: string;
  kind?: string;
  requestId?: string;
  command?: string;
  status?: string;
  summary?: string;
  details?: Record<string, unknown>;
};

type EventsCliResult = {
  path?: string;
  cursor?: string;
  nextCursor?: string;
  limit?: number;
  events?: readonly EventsCliEntry[];
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

function eventsCliOutput(data: EventsCliResult): CliOutput {
  const events = data.events ?? [];
  return {
    data,
    text: events.length > 0 ? formatEventEntries(events) : 'No session events found.',
    stderr: joinDefinedLines([
      formatKeyValueFields(data, ['path', 'cursor', 'nextCursor', 'limit'] as const),
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
  events: resultOutput<EventsCliResult>(eventsCliOutput),
  network: resultOutput<NetworkCliResult>(networkCliOutput),
  audio: resultOutput<AudioCliResult>(audioCliOutput),
} as const satisfies Record<string, CliOutputFormatter>;

function formatEventEntries(entries: readonly EventsCliEntry[]): string {
  const rows = entries.map(formatEventRow);
  const labelWidth = Math.min(Math.max(...rows.map((row) => row.label.length), 'event'.length), 32);
  return rows.map((row) => formatEventRowLine(row, labelWidth)).join('\n');
}

function formatEventRow(entry: EventsCliEntry): {
  timestamp: string;
  label: string;
  summary: string;
} {
  return {
    timestamp: formatEventTimestamp(entry.ts),
    label: formatEventLabel(entry),
    summary: formatEventSummary(entry),
  };
}

function formatEventRowLine(
  row: { timestamp: string; label: string; summary: string },
  labelWidth: number,
): string {
  const label = row.label.padEnd(labelWidth);
  const prefix = row.timestamp ? `${row.timestamp}  ${label}` : label.trimEnd();
  return row.summary ? `${prefix}  ${row.summary}` : prefix.trimEnd();
}

function formatEventTimestamp(value: string | undefined): string {
  if (!value) return '';
  return value.replace('T', ' ');
}

function formatEventLabel(entry: EventsCliEntry): string {
  const command = entry.command ?? 'command';
  switch (entry.kind) {
    case 'request.started':
      return `start ${command}`;
    case 'request.finished':
      return joinDefinedWords([
        entry.status === 'error' ? 'error' : 'ok',
        command,
        formatDuration(readNumber(entry.details?.durationMs)),
      ]);
    case 'action.recorded':
      return `action ${command}`;
    default:
      return joinDefinedWords([entry.kind ?? 'event', entry.command]);
  }
}

function formatEventSummary(entry: EventsCliEntry): string {
  const summary = compactDefaultSummary(entry.summary, entry);
  const hints = formatEventHints(entry, summary);
  return `${summary}${hints}`.trim();
}

function compactDefaultSummary(summary: string | undefined, entry: EventsCliEntry): string {
  const text = summary?.trim() ?? '';
  const command = entry.command ?? '';
  if (entry.kind === 'request.started' && text === `Started ${command}`) return '';
  if (entry.kind === 'request.finished' && text === `Finished ${command}`) return '';
  return text;
}

function formatEventHints(entry: EventsCliEntry, summary: string): string {
  if (entry.kind !== 'action.recorded') return '';
  const details = entry.details;
  if (!details) return '';
  const hints = [
    formatActionTargetHint(details, summary),
    formatTextLengthHint(readNumber(details.textLength)),
  ].filter((hint): hint is string => Boolean(hint));
  return hints.length > 0 ? ` (${hints.join(', ')})` : '';
}

function formatActionTargetHint(
  details: Record<string, unknown>,
  summary: string,
): string | undefined {
  const target = readString(details.ref) ?? readString(details.selector) ?? formatPoint(details);
  if (!target || summary.includes(target)) return undefined;
  return `target=${target}`;
}

function formatPoint(details: Record<string, unknown>): string | undefined {
  const x = readNumber(details.x);
  const y = readNumber(details.y);
  return x === undefined || y === undefined ? undefined : `(${x}, ${y})`;
}

function formatTextLengthHint(length: number | undefined): string | undefined {
  return length === undefined ? undefined : `text=${length} chars`;
}

function formatDuration(durationMs: number | undefined): string | undefined {
  return durationMs === undefined ? undefined : `${Math.round(durationMs)}ms`;
}

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

function joinDefinedWords(words: Array<string | undefined>): string {
  return words.filter((word): word is string => Boolean(word)).join(' ');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
