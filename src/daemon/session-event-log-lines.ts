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
 * Visit each non-blank line of one event log file in order. Return false from
 * `onLine` to stop. A file that disappeared (rotation renamed it between the
 * caller's listing and this open) reports as absent rather than throwing.
 */
export function scanEventLogLines(
  filePath: string,
  onLine: (line: string) => boolean | void,
): boolean {
  const fd = openSyncIfExists(filePath);
  if (fd === undefined) return false;
  try {
    const splitter = createLineSplitter(onLine);
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!splitter.push(buffer.subarray(0, bytesRead))) return true;
    } while (bytesRead > 0);
    splitter.end();
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** Line count plus first-line digest, read without blocking the event loop. */
export async function measureEventLogFile(filePath: string): Promise<EventLogFileMeasurement> {
  const handle = await openIfExists(filePath);
  if (handle === undefined) return { lineCount: 0, firstLineDigest: undefined };
  const measurement: EventLogFileMeasurement = { lineCount: 0, firstLineDigest: undefined };
  try {
    const splitter = createLineSplitter((line) => {
      if (measurement.lineCount === 0) measurement.firstLineDigest = digestEventLogLine(line);
      measurement.lineCount += 1;
    });
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      splitter.push(buffer.subarray(0, bytesRead));
      if (bytesRead === 0) break;
    }
    splitter.end();
    return measurement;
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

/** Splits streamed chunks into event-log lines; `push` returns false once the consumer stops. */
function createLineSplitter(onLine: (line: string) => boolean | void): {
  push: (chunk: Buffer) => boolean;
  end: () => void;
} {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let stopped = false;
  return {
    push(chunk) {
      if (stopped) return false;
      const text = `${pending}${decoder.write(chunk)}`;
      let start = 0;
      for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', start)) {
        if (visitLine(text.slice(start, index), onLine) === false) {
          stopped = true;
          return false;
        }
        start = index + 1;
      }
      pending = text.slice(start);
      return true;
    },
    end() {
      if (!stopped) visitLine(`${pending}${decoder.end()}`, onLine);
    },
  };
}

function visitLine(rawLine: string, onLine: (line: string) => boolean | void): boolean | void {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (line.trim().length === 0) return;
  return onLine(line);
}

function openSyncIfExists(filePath: string): number | undefined {
  try {
    return fs.openSync(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function openIfExists(filePath: string): Promise<fs.promises.FileHandle | undefined> {
  try {
    return await fs.promises.open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
