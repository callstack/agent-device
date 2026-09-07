import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import {
  measureEventLogFile,
  readFirstLineDigest,
  scanEventLogLines,
} from './session-event-log-lines.ts';

/**
 * Retention window for a session's `events.ndjson` (#1788).
 *
 * The `events` reader pages with a cursor that is an absolute line index since
 * the log was created, and callers persist `nextCursor` to resume, so the
 * app-log's rotate-and-truncate would silently renumber every live cursor.
 * Rotation here keeps the index absolute instead: one rotated generation
 * (`events.ndjson.1`) is retained and a sidecar records, per generation, its
 * first absolute line index, its line count, and a digest of its first line.
 *
 * The digest is what makes the mapping **verifiable rather than declared**.
 * The sidecar is written *before* the destructive rename, so a reader can land
 * on either side of it; it identifies each file on disk by digest and derives
 * that file's absolute start from the matching record, then checks the
 * recorded line count and the two files' contiguity against what is actually
 * on disk. Anything it cannot verify — an unrecorded rotated file, a line
 * count that moved, a gap between generations, a corrupt sidecar — raises a
 * typed error. The reader never guesses an offset.
 *
 * Entry bytes are never rewritten (ADR 0018 keeps `events.ndjson` v1 lines
 * byte-compatible); only whole files move.
 */

const DEFAULT_EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const ROTATED_EVENT_LOG_SUFFIX = '.1';
const EVENT_LOG_WINDOW_SUFFIX = '.window.json';
const EVENT_LOG_WINDOW_VERSION = 2;
const RETAINED_GENERATIONS = 2;
const WINDOW_READ_ATTEMPTS = 3;

export const EVENT_LOG_CURSOR_EXPIRED_REASON = 'EVENT_LOG_CURSOR_EXPIRED';
export const EVENT_LOG_WINDOW_UNVERIFIED_REASON = 'EVENT_LOG_WINDOW_UNVERIFIED';

/** One retained file generation, identified by the digest of its first line. */
type EventLogGeneration = {
  firstLineIndex: number;
  lineCount: number;
  firstLineDigest: string;
};

type EventLogWindowFile = { path: string; firstLineIndex: number };

export type SessionEventLogWindow = {
  /** Retained files, oldest first, each with its absolute starting index. */
  files: EventLogWindowFile[];
  /** Oldest absolute cursor that still resolves. */
  earliestCursor: number;
};

/**
 * `AGENT_DEVICE_EVENT_LOG_MAX_BYTES` overrides the active-file cap, in whole
 * bytes (the app-log precedent is `AGENT_DEVICE_APP_LOG_MAX_BYTES`). One
 * rotated generation is always kept, so a live cursor can read at least
 * `maxBytes` of history after any rotation. A non-integer value is ignored
 * rather than parsed leniently: `5MB` is not 5 bytes.
 */
export function resolveSessionEventLogMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_DEVICE_EVENT_LOG_MAX_BYTES?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_EVENT_LOG_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_EVENT_LOG_MAX_BYTES;
}

export function resolveRotatedSessionEventLogPath(eventLogPath: string): string {
  return `${eventLogPath}${ROTATED_EVENT_LOG_SUFFIX}`;
}

function resolveWindowPath(eventLogPath: string): string {
  return `${eventLogPath}${EVENT_LOG_WINDOW_SUFFIX}`;
}

/**
 * Resolve which files hold which absolute line indices, verifying every claim
 * the sidecar makes against the files themselves.
 *
 * The reader is synchronous but rotation's `fs.promises` calls land from the
 * libuv threadpool, so the filesystem can move *between* two of this
 * function's own sync reads. Each attempt therefore re-reads the sidecar after
 * placing the files and retries when it changed underneath — a torn snapshot
 * is retried, never interpreted. A state that stays inconsistent across
 * attempts is a real fault and raises a typed error.
 */
export function readSessionEventLogWindow(eventLogPath: string): SessionEventLogWindow {
  let lastError: unknown;
  for (let attempt = 0; attempt < WINDOW_READ_ATTEMPTS; attempt += 1) {
    const before = readWindowStateToken(eventLogPath);
    try {
      const window = placeSessionEventLogWindow(eventLogPath);
      if (readWindowStateToken(eventLogPath) === before) return window;
    } catch (error) {
      lastError = error;
      if (readWindowStateToken(eventLogPath) === before) throw error;
    }
  }
  throw lastError ?? unverifiedWindowError(eventLogPath, 'the window did not settle while reading');
}

function placeSessionEventLogWindow(eventLogPath: string): SessionEventLogWindow {
  const rotatedPath = resolveRotatedSessionEventLogPath(eventLogPath);
  const sidecar = readWindowSidecar(eventLogPath);
  if (sidecar === 'unverifiable') {
    throw unverifiedWindowError(eventLogPath, 'window file is invalid');
  }
  if (sidecar === undefined) return placeNeverRotatedWindow(eventLogPath, rotatedPath);

  const newest = sidecar.at(-1);
  if (!newest) throw unverifiedWindowError(eventLogPath, 'window file records no generation');

  const activeExists = fileExists(eventLogPath);
  const activeStart = placeActiveGeneration(eventLogPath, newest);
  const files: EventLogWindowFile[] = [];
  const rotatedStart = placeRotatedGeneration({
    eventLogPath,
    rotatedPath,
    sidecar,
    activeStart,
    activeExists,
  });
  if (rotatedStart !== undefined) files.push({ path: rotatedPath, firstLineIndex: rotatedStart });
  if (activeExists) files.push({ path: eventLogPath, firstLineIndex: activeStart });
  return { files, earliestCursor: files[0]?.firstLineIndex ?? activeStart };
}

/** No sidecar means the log has never rotated, so the active file starts the timeline. */
function placeNeverRotatedWindow(eventLogPath: string, rotatedPath: string): SessionEventLogWindow {
  if (readFirstLineDigest(rotatedPath) !== undefined) {
    throw unverifiedWindowError(eventLogPath, 'a rotated event log exists with no window record');
  }
  return {
    files: fileExists(eventLogPath) ? [{ path: eventLogPath, firstLineIndex: 0 }] : [],
    earliestCursor: 0,
  };
}

/**
 * The newest record describes the generation that was in the active file when
 * the sidecar was written, so a first line still matching it means the rename
 * has not landed yet and the active file is still that generation.
 */
function placeActiveGeneration(eventLogPath: string, newest: EventLogGeneration): number {
  const activeDigest = readFirstLineDigest(eventLogPath);
  return activeDigest !== undefined && activeDigest === newest.firstLineDigest
    ? newest.firstLineIndex
    : newest.firstLineIndex + newest.lineCount;
}

/** Returns the rotated file's absolute start, or undefined when it is absent. */
function placeRotatedGeneration(params: {
  eventLogPath: string;
  rotatedPath: string;
  sidecar: readonly EventLogGeneration[];
  activeStart: number;
  activeExists: boolean;
}): number | undefined {
  const { eventLogPath, rotatedPath, sidecar, activeStart, activeExists } = params;
  const rotatedDigest = readFirstLineDigest(rotatedPath);
  if (rotatedDigest === undefined) return undefined;
  const record = sidecar.find((generation) => generation.firstLineDigest === rotatedDigest);
  if (!record) {
    throw unverifiedWindowError(eventLogPath, 'the rotated event log matches no window record');
  }
  const observedLines = countLines(rotatedPath);
  if (observedLines !== record.lineCount) {
    throw unverifiedWindowError(
      eventLogPath,
      `the rotated event log holds ${observedLines} lines, the window recorded ${record.lineCount}`,
    );
  }
  if (activeExists && record.firstLineIndex + record.lineCount !== activeStart) {
    throw unverifiedWindowError(eventLogPath, 'retained event log generations are not contiguous');
  }
  return record.firstLineIndex;
}

/**
 * Rotate `events.ndjson` to `events.ndjson.1` once it reaches `maxBytes`.
 *
 * Runs inside the per-path serialized write queue. The sidecar describing the
 * post-rename world is written first, so the only intermediate state a reader
 * can observe is "sidecar ahead of rename" — which the digests identify
 * exactly. A sidecar this function cannot read never blocks the append: the
 * window is marked unverifiable (reads then fail typed) and writing continues.
 */
export async function rotateSessionEventLogIfNeeded(
  eventLogPath: string,
  maxBytes: number,
): Promise<boolean> {
  const active = lstatEventLogFile(eventLogPath);
  if (!active || active.size < maxBytes) return false;

  const sidecar = readWindowSidecar(eventLogPath);
  if (sidecar === 'unverifiable') {
    await fs.promises.rename(eventLogPath, resolveRotatedSessionEventLogPath(eventLogPath));
    return true;
  }

  const measured = await measureEventLogFile(eventLogPath);
  if (measured.firstLineDigest !== undefined) {
    const generations = sidecar ?? [];
    const newest = generations.at(-1);
    // A record whose digest already matches this exact file means a previous
    // rotation wrote the record but died before its rename; reuse it instead of
    // counting the same generation twice.
    const record: EventLogGeneration =
      newest && newest.firstLineDigest === measured.firstLineDigest
        ? newest
        : {
            firstLineIndex: newest ? newest.firstLineIndex + newest.lineCount : 0,
            lineCount: measured.lineCount,
            firstLineDigest: measured.firstLineDigest,
          };
    const next = (record === newest ? generations : [...generations, record]).slice(
      -RETAINED_GENERATIONS,
    );
    await writeWindowSidecar(eventLogPath, next);
  }
  await fs.promises.rename(eventLogPath, resolveRotatedSessionEventLogPath(eventLogPath));
  return true;
}

export function assertSessionEventLogCursorRetained(cursor: number, earliestCursor: number): void {
  if (cursor >= earliestCursor) return;
  throw new AppError(
    'COMMAND_FAILED',
    `events cursor ${cursor} precedes the retained event log window; events before cursor ${earliestCursor} were rotated out.`,
    {
      reason: EVENT_LOG_CURSOR_EXPIRED_REASON,
      cursor,
      earliestCursor,
      hint: `Resume with cursor ${earliestCursor}, the oldest retained event; earlier events are no longer available.`,
    },
  );
}

function unverifiedWindowError(eventLogPath: string, detail: string): AppError {
  return new AppError('COMMAND_FAILED', `Session event log window cannot be verified: ${detail}.`, {
    reason: EVENT_LOG_WINDOW_UNVERIFIED_REASON,
    path: eventLogPath,
    hint: `Cursor positions for this session cannot be resolved. Delete ${eventLogPath}, ${resolveRotatedSessionEventLogPath(eventLogPath)}, and ${resolveWindowPath(eventLogPath)} to restart the timeline, or read the files directly.`,
  });
}

function countLines(filePath: string): number {
  let count = 0;
  scanEventLogLines(filePath, () => {
    count += 1;
  });
  return count;
}

/**
 * Identity of everything the placement reads: the sidecar's bytes and each
 * retained file's inode/size/mtime. Rotation's rename and sidecar write land
 * from the threadpool, so comparing this before and after a placement is what
 * distinguishes "read a torn snapshot" from "the window is really broken".
 */
function readWindowStateToken(eventLogPath: string): string {
  return [
    readFileToken(resolveWindowPath(eventLogPath)),
    readFileToken(eventLogPath),
    readFileToken(resolveRotatedSessionEventLogPath(eventLogPath)),
  ].join('|');
}

function readFileToken(filePath: string): string {
  try {
    const stats = fs.lstatSync(filePath);
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

/** `undefined` when never rotated, `'unverifiable'` when the file is unusable. */
function readWindowSidecar(
  eventLogPath: string,
): EventLogGeneration[] | 'unverifiable' | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(resolveWindowPath(eventLogPath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return 'unverifiable';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== EVENT_LOG_WINDOW_VERSION) return 'unverifiable';
    const { generations } = parsed;
    if (!Array.isArray(generations) || generations.length === 0) return 'unverifiable';
    const records = generations.map(readGeneration);
    return records.every((record) => record !== undefined)
      ? (records as EventLogGeneration[])
      : 'unverifiable';
  } catch {
    return 'unverifiable';
  }
}

function readGeneration(value: unknown): EventLogGeneration | undefined {
  if (!isRecord(value)) return undefined;
  const { firstLineIndex, lineCount, firstLineDigest } = value;
  if (!Number.isSafeInteger(firstLineIndex) || (firstLineIndex as number) < 0) return undefined;
  if (!Number.isSafeInteger(lineCount) || (lineCount as number) < 0) return undefined;
  if (typeof firstLineDigest !== 'string' || firstLineDigest.length === 0) return undefined;
  return {
    firstLineIndex: firstLineIndex as number,
    lineCount: lineCount as number,
    firstLineDigest,
  };
}

async function writeWindowSidecar(
  eventLogPath: string,
  generations: readonly EventLogGeneration[],
): Promise<void> {
  const windowPath = resolveWindowPath(eventLogPath);
  const tmpPath = `${windowPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(
    tmpPath,
    JSON.stringify({ version: EVENT_LOG_WINDOW_VERSION, generations }),
    'utf8',
  );
  await fs.promises.rename(tmpPath, windowPath);
}

function fileExists(filePath: string): boolean {
  return lstatEventLogFile(filePath) !== undefined;
}

/** Refuses a symlinked event log, as the app-log rotation model does. */
function lstatEventLogFile(filePath: string): fs.Stats | undefined {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      throw new AppError(
        'COMMAND_FAILED',
        `Session event log must not be a symbolic link: ${filePath}`,
      );
    }
    return stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
