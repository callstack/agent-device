import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PUBLIC_COMMANDS } from '../command-catalog.ts';
import { AppError } from '../kernel/errors.ts';
import { redactDiagnosticData } from '../kernel/redaction.ts';
import { emitDiagnostic, getDiagnosticsMeta } from '../utils/diagnostics.ts';
import { isRecord } from '../utils/parsing.ts';
import type { DaemonRequest, DaemonResponse, SessionAction } from './types.ts';
import { buildActionDetails, buildActionSummary } from './session-event-action.ts';

const SESSION_EVENT_LOG_FILENAME = 'events.ndjson';
const EVENT_LOG_VERSION = 1;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
const EVENT_LOG_READ_CHUNK_BYTES = 64 * 1024;
const pendingEventLogWrites = new Map<string, Promise<void>>();
const ensuredEventLogDirs = new Set<string>();

export type SessionEventLogEntry = {
  version: 1;
  ts: string;
  session: string;
  kind: 'request.started' | 'request.finished' | 'action.recorded';
  requestId?: string;
  command?: string;
  status?: 'ok' | 'error';
  summary?: string;
  details?: Record<string, unknown>;
};

export type SessionEventLogPage = {
  path: string;
  cursor: string;
  limit: number;
  events: SessionEventLogEntry[];
  nextCursor?: string;
};

export type SessionEventLogInput = Omit<SessionEventLogEntry, 'version' | 'ts' | 'session'> & {
  ts?: string;
};

type ReadSessionEventLogOptions = { cursor?: string; limit?: number | string };
type RawSessionEventLogEntry = Record<string, unknown> &
  Pick<SessionEventLogEntry, 'version' | 'ts' | 'session' | 'kind'>;

export function resolveSessionEventLogPath(sessionDir: string): string {
  return path.join(sessionDir, SESSION_EVENT_LOG_FILENAME);
}

export function shouldRecordEventForRequest(req: Pick<DaemonRequest, 'command'>): boolean {
  return req.command !== PUBLIC_COMMANDS.events;
}

export function appendSessionEvent(
  eventLogPath: string,
  sessionName: string,
  event: SessionEventLogInput,
): void {
  const entry = redactDiagnosticData({
    version: EVENT_LOG_VERSION,
    ts: event.ts ?? new Date().toISOString(),
    session: sessionName,
    ...event,
  } satisfies SessionEventLogEntry);
  queueEventLogWrite(eventLogPath, `${JSON.stringify(entry)}\n`);
}

export async function flushSessionEventLogWrites(eventLogPath?: string): Promise<void> {
  const pending = eventLogPath
    ? pendingEventLogWrites.get(eventLogPath)
    : Promise.all(pendingEventLogWrites.values());
  await pending;
}

function queueEventLogWrite(eventLogPath: string, line: string): void {
  const previous = pendingEventLogWrites.get(eventLogPath) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(async () => {
      await ensureEventLogDir(eventLogPath);
      await fs.promises.appendFile(eventLogPath, line, 'utf8');
    })
    .catch((error) => {
      emitDiagnostic({
        level: 'warn',
        phase: 'session_event_log_write_failed',
        data: {
          path: eventLogPath,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    })
    .finally(() => {
      if (pendingEventLogWrites.get(eventLogPath) === pending) {
        pendingEventLogWrites.delete(eventLogPath);
      }
    });
  pendingEventLogWrites.set(eventLogPath, pending);
}

async function ensureEventLogDir(eventLogPath: string): Promise<void> {
  const dir = path.dirname(eventLogPath);
  if (ensuredEventLogDirs.has(dir)) return;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    ensuredEventLogDirs.add(dir);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'session_event_log_dir_failed',
      data: {
        path: eventLogPath,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export function appendActionEvent(
  eventLogPath: string,
  sessionName: string,
  action: SessionAction,
): void {
  appendSessionEvent(eventLogPath, sessionName, {
    kind: 'action.recorded',
    requestId: getDiagnosticsMeta().requestId,
    command: action.command,
    summary: buildActionSummary(action),
    details: buildActionDetails(action),
  });
}

export function buildRequestStartedEvent(params: {
  req: DaemonRequest;
  sessionName: string;
  requestLogPath: string;
  runnerLogPath: string;
}): SessionEventLogInput {
  const { req, sessionName, requestLogPath, runnerLogPath } = params;
  return {
    kind: 'request.started',
    requestId: req.meta?.requestId ?? getDiagnosticsMeta().requestId,
    command: req.command,
    summary: `Started ${req.command}`,
    details: {
      publicSession: req.session,
      effectiveSession: sessionName,
      tenant: req.meta?.tenantId,
      isolation: req.meta?.sessionIsolation,
      requestLogPath,
      runnerLogPath,
    },
  };
}

export function buildRequestFinishedEvent(params: {
  req: DaemonRequest;
  response: DaemonResponse;
  durationMs: number;
}): SessionEventLogInput {
  const { req, response, durationMs } = params;
  if (response.ok) {
    return {
      kind: 'request.finished',
      requestId: req.meta?.requestId ?? getDiagnosticsMeta().requestId,
      command: req.command,
      status: 'ok',
      summary: `Finished ${req.command}`,
      details: { durationMs },
    };
  }
  return {
    kind: 'request.finished',
    requestId: req.meta?.requestId ?? getDiagnosticsMeta().requestId,
    command: req.command,
    status: 'error',
    summary: `Failed ${req.command}: ${response.error.code}`,
    details: {
      durationMs,
      code: response.error.code,
      diagnosticId: response.error.diagnosticId,
      logPath: response.error.logPath,
    },
  };
}

export function readSessionEventLog(
  eventLogPath: string,
  options: ReadSessionEventLogOptions = {},
): SessionEventLogPage {
  const cursor = normalizeCursor(options.cursor);
  const limit = normalizeLimit(options.limit);
  if (!fs.existsSync(eventLogPath)) {
    return { path: eventLogPath, cursor: String(cursor), limit, events: [] };
  }

  const page = readSessionEventLogLines(eventLogPath, cursor, limit);
  const events = page.lines.flatMap((line) => {
    const parsed = parseSessionEventLogLine(line);
    return parsed ? [parsed] : [];
  });
  return {
    path: eventLogPath,
    cursor: String(cursor),
    limit,
    events,
    ...(page.nextCursor !== undefined ? { nextCursor: String(page.nextCursor) } : {}),
  };
}

function readSessionEventLogLines(
  eventLogPath: string,
  cursor: number,
  limit: number,
): { lines: string[]; nextCursor?: number } {
  const fd = fs.openSync(eventLogPath, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(EVENT_LOG_READ_CHUNK_BYTES);
    const state = createLineScanState(cursor, limit);
    let pending = '';
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      const chunk = decoder.write(buffer.subarray(0, bytesRead));
      pending = consumeEventLogChunk(`${pending}${chunk}`, state);
    } while (bytesRead > 0 && state.nextCursor === undefined);
    const remainder = `${pending}${decoder.end()}`;
    if (state.nextCursor === undefined && remainder.length > 0) {
      consumeEventLogLine(remainder, state);
    }
    return { lines: state.lines, nextCursor: state.nextCursor };
  } finally {
    fs.closeSync(fd);
  }
}

function createLineScanState(
  cursor: number,
  limit: number,
): {
  cursor: number;
  limit: number;
  lineIndex: number;
  lines: string[];
  nextCursor?: number;
} {
  return {
    cursor,
    limit,
    lineIndex: 0,
    lines: [],
  };
}

function consumeEventLogChunk(text: string, state: ReturnType<typeof createLineScanState>): string {
  let start = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', start)) {
    consumeEventLogLine(text.slice(start, index), state);
    start = index + 1;
    if (state.nextCursor !== undefined) return '';
  }
  return text.slice(start);
}

function consumeEventLogLine(rawLine: string, state: ReturnType<typeof createLineScanState>): void {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (line.trim().length === 0) return;
  if (state.lineIndex >= state.cursor + state.limit) {
    state.nextCursor = state.cursor + state.limit;
    return;
  }
  if (state.lineIndex >= state.cursor) {
    state.lines.push(line);
  }
  state.lineIndex += 1;
}

function normalizeCursor(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  const cursor = Number(value);
  if (Number.isInteger(cursor) && cursor >= 0) return cursor;
  throw new AppError('INVALID_ARGS', 'events cursor must be a non-negative integer string.');
}

function normalizeLimit(value: number | string | undefined): number {
  if (value === undefined) return DEFAULT_EVENT_LIMIT;
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_EVENT_LIMIT;
  const limit = typeof value === 'string' ? Number(value) : value;
  if (Number.isInteger(limit) && limit >= 1 && limit <= MAX_EVENT_LIMIT) return limit;
  throw new AppError('INVALID_ARGS', `events limit must be between 1 and ${MAX_EVENT_LIMIT}.`);
}

function parseSessionEventLogLine(line: string): SessionEventLogEntry | undefined {
  try {
    const parsed = readRawSessionEventLogEntry(JSON.parse(line));
    return parsed ? buildSessionEventLogEntry(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function readRawSessionEventLogEntry(value: unknown): RawSessionEventLogEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== EVENT_LOG_VERSION) return undefined;
  if (typeof value.ts !== 'string' || typeof value.session !== 'string') return undefined;
  if (!isSessionEventKind(value.kind)) return undefined;
  return value as RawSessionEventLogEntry;
}

function buildSessionEventLogEntry(parsed: RawSessionEventLogEntry): SessionEventLogEntry {
  const details = isRecord(parsed.details) ? parsed.details : undefined;
  return {
    version: EVENT_LOG_VERSION,
    ts: parsed.ts,
    session: parsed.session,
    kind: parsed.kind,
    ...(typeof parsed.requestId === 'string' ? { requestId: parsed.requestId } : {}),
    ...(typeof parsed.command === 'string' ? { command: parsed.command } : {}),
    ...(isSessionEventStatus(parsed.status) ? { status: parsed.status } : {}),
    ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
    ...(details ? { details } : {}),
  };
}

function isSessionEventKind(value: unknown): value is SessionEventLogEntry['kind'] {
  return value === 'request.started' || value === 'request.finished' || value === 'action.recorded';
}

function isSessionEventStatus(
  value: unknown,
): value is NonNullable<SessionEventLogEntry['status']> {
  return value === 'ok' || value === 'error';
}
