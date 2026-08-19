import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

/**
 * ndjson line reading primitive for the session event log: one line rule
 * (CRLF-tolerant, blank lines are not lines) shared by the paging reader and
 * the retention window's measurements, so the two can never disagree about
 * what an absolute line index counts.
 */

const READ_CHUNK_BYTES = 64 * 1024;

export type EventLogFileMeasurement = {
  lineCount: number;
  /** Digest of the first line's exact bytes; identifies a file generation. */
  firstLineDigest: string | undefined;
};

export function digestEventLogLine(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Visit each non-blank line of one event log file in order. Returns false from
 * `onLine` to stop. A file that disappeared (rotation renamed it between the
 * caller's listing and this open) reports as absent rather than throwing.
 */
export function scanEventLogLines(
  filePath: string,
  onLine: (line: string) => boolean | void,
): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let pending = '';
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      const text = `${pending}${decoder.write(buffer.subarray(0, bytesRead))}`;
      let start = 0;
      for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', start)) {
        if (visitLine(text.slice(start, index), onLine) === false) return true;
        start = index + 1;
      }
      pending = text.slice(start);
    } while (bytesRead > 0);
    visitLine(`${pending}${decoder.end()}`, onLine);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** Line count plus first-line digest, read without blocking the event loop. */
export async function measureEventLogFile(filePath: string): Promise<EventLogFileMeasurement> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { lineCount: 0, firstLineDigest: undefined };
    }
    throw error;
  }
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let pending = '';
    let lineCount = 0;
    let firstLineDigest: string | undefined;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      const text = `${pending}${decoder.write(buffer.subarray(0, bytesRead))}`;
      let start = 0;
      for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', start)) {
        const line = normalizeLine(text.slice(start, index));
        if (line !== undefined) {
          if (lineCount === 0) firstLineDigest = digestEventLogLine(line);
          lineCount += 1;
        }
        start = index + 1;
      }
      pending = text.slice(start);
      if (bytesRead === 0) break;
    }
    const trailing = normalizeLine(`${pending}${decoder.end()}`);
    if (trailing !== undefined) {
      if (lineCount === 0) firstLineDigest = digestEventLogLine(trailing);
      lineCount += 1;
    }
    return { lineCount, firstLineDigest };
  } finally {
    await handle.close();
  }
}

/** First line's digest, or undefined when the file is absent or has no line. */
export function readFirstLineDigest(filePath: string): string | undefined {
  let digest: string | undefined;
  scanEventLogLines(filePath, (line) => {
    digest = digestEventLogLine(line);
    return false;
  });
  return digest;
}

function normalizeLine(rawLine: string): string | undefined {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  return line.trim().length === 0 ? undefined : line;
}

function visitLine(rawLine: string, onLine: (line: string) => boolean | void): boolean | void {
  const line = normalizeLine(rawLine);
  if (line === undefined) return;
  return onLine(line);
}
