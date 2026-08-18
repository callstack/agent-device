import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '../utils/parsing.ts';

/**
 * Retention window for a session's `events.ndjson` (#1788).
 *
 * The `events` reader pages with a cursor that is an absolute line index since
 * the log was created, and callers persist `nextCursor` to resume. A
 * rotate-and-truncate copied from `app-log-files.ts` would reset that index to
 * 0 and make a resumed cursor silently read the wrong events. Rotation here
 * keeps the index absolute: exactly one rotated generation (`events.ndjson.1`)
 * is retained, and a sidecar (`events.ndjson.window.json`) records how many
 * lines were dropped ahead of the oldest retained file. The reader maps an
 * absolute cursor onto the retained files through that offset and answers a
 * cursor that fell off the window with a typed `EVENT_LOG_CURSOR_EXPIRED` error instead
 * of a wrong page.
 *
 * Entry bytes are never rewritten (ADR 0018 keeps `events.ndjson` v1 lines
 * byte-compatible); only whole files move.
 */

const DEFAULT_EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const ROTATED_EVENT_LOG_SUFFIX = '.1';
const EVENT_LOG_WINDOW_SUFFIX = '.window.json';
const EVENT_LOG_WINDOW_VERSION = 1;
const EVENT_LOG_READ_CHUNK_BYTES = 64 * 1024;

export const EVENT_LOG_CURSOR_EXPIRED_REASON = 'EVENT_LOG_CURSOR_EXPIRED';

export type SessionEventLogWindow = {
  /** Absolute line index of the first line in the oldest retained file. */
  droppedLines: number;
  /** Retained files, oldest first; only files that exist. */
  files: string[];
};

/**
 * `AGENT_DEVICE_EVENT_LOG_MAX_BYTES` overrides the active-file cap in bytes
 * (the app-log precedent is `AGENT_DEVICE_APP_LOG_MAX_BYTES`). One rotated
 * generation is always kept, so a live cursor can read at least `maxBytes` of
 * history after any rotation.
 */
export function resolveSessionEventLogMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_EVENT_LOG_MAX_BYTES;
}

export function resolveRotatedSessionEventLogPath(eventLogPath: string): string {
  return `${eventLogPath}${ROTATED_EVENT_LOG_SUFFIX}`;
}

function resolveSessionEventLogWindowPath(eventLogPath: string): string {
  return `${eventLogPath}${EVENT_LOG_WINDOW_SUFFIX}`;
}

export function readSessionEventLogWindow(eventLogPath: string): SessionEventLogWindow {
  const files = [resolveRotatedSessionEventLogPath(eventLogPath), eventLogPath].filter((file) =>
    fs.existsSync(file),
  );
  return { droppedLines: readDroppedLines(eventLogPath), files };
}

/**
 * Rotate `events.ndjson` to `events.ndjson.1` once the active file reaches
 * `maxBytes`, dropping the previous rotated generation and advancing the
 * window offset by the lines it held. Runs inside the per-path serialized
 * write queue, so no append interleaves with the rename.
 *
 * Order: drop, rename, then record the offset. A failure before the sidecar
 * write leaves the offset stale for that generation rather than double
 * counting it on the retry the next append performs.
 */
export async function rotateSessionEventLogIfNeeded(
  eventLogPath: string,
  maxBytes: number,
): Promise<boolean> {
  const active = await statIfExists(eventLogPath);
  if (!active || active.size < maxBytes) return false;
  const rotatedPath = resolveRotatedSessionEventLogPath(eventLogPath);
  const rotated = await statIfExists(rotatedPath);
  const rotatedLines = rotated ? countSessionEventLogLines(rotatedPath) : 0;
  if (rotated) await fs.promises.unlink(rotatedPath);
  await fs.promises.rename(eventLogPath, rotatedPath);
  if (rotated) await writeDroppedLines(eventLogPath, readDroppedLines(eventLogPath) + rotatedLines);
  return true;
}

export function assertSessionEventLogCursorRetained(cursor: number, droppedLines: number): void {
  if (cursor >= droppedLines) return;
  throw new AppError(
    'COMMAND_FAILED',
    `events cursor ${cursor} precedes the retained event log window; events before cursor ${droppedLines} were rotated out.`,
    {
      reason: EVENT_LOG_CURSOR_EXPIRED_REASON,
      cursor,
      earliestCursor: droppedLines,
      hint: `Resume with cursor ${droppedLines}, the oldest retained event; earlier events are no longer available.`,
    },
  );
}

/**
 * Visit each non-blank line of one event log file in order, applying the
 * line rule the reader uses (CRLF-tolerant, blank lines are not lines).
 * Returning `false` from `onLine` stops the scan.
 */
export function scanSessionEventLogLines(
  filePath: string,
  onLine: (line: string) => boolean | void,
): void {
  const fd = fs.openSync(filePath, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(EVENT_LOG_READ_CHUNK_BYTES);
    let pending = '';
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      const text = `${pending}${decoder.write(buffer.subarray(0, bytesRead))}`;
      let start = 0;
      for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', start)) {
        if (visitLine(text.slice(start, index), onLine) === false) return;
        start = index + 1;
      }
      pending = text.slice(start);
    } while (bytesRead > 0);
    visitLine(`${pending}${decoder.end()}`, onLine);
  } finally {
    fs.closeSync(fd);
  }
}

function visitLine(rawLine: string, onLine: (line: string) => boolean | void): boolean | void {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (line.trim().length === 0) return;
  return onLine(line);
}

function countSessionEventLogLines(filePath: string): number {
  let count = 0;
  scanSessionEventLogLines(filePath, () => {
    count += 1;
  });
  return count;
}

function readDroppedLines(eventLogPath: string): number {
  const windowPath = resolveSessionEventLogWindowPath(eventLogPath);
  let raw: string;
  try {
    raw = fs.readFileSync(windowPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const parsed = parseWindowFile(raw);
  if (parsed === undefined) {
    throw new AppError(
      'COMMAND_FAILED',
      `Session event log window file is invalid: ${windowPath}`,
      {
        hint: 'Delete the window file to read the retained event log from cursor 0; cursors issued before it was corrupted no longer resolve.',
      },
    );
  }
  return parsed;
}

function parseWindowFile(raw: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== EVENT_LOG_WINDOW_VERSION) return undefined;
    const { droppedLines } = parsed;
    return typeof droppedLines === 'number' && Number.isInteger(droppedLines) && droppedLines >= 0
      ? droppedLines
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeDroppedLines(eventLogPath: string, droppedLines: number): Promise<void> {
  const windowPath = resolveSessionEventLogWindowPath(eventLogPath);
  const tmpPath = `${windowPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(
    tmpPath,
    JSON.stringify({ version: EVENT_LOG_WINDOW_VERSION, droppedLines }),
    'utf8',
  );
  await fs.promises.rename(tmpPath, windowPath);
}

async function statIfExists(filePath: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
