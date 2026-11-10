import fs from 'node:fs';
import type {
  AppLogProcessMarkerReadOutcome,
  AppLogSessionArtifacts,
} from '@agent-device/contracts/app-log-runtime';
import type {
  NetworkAppLogRead,
  NetworkRuntimeHost,
  NetworkTransport,
} from '@agent-device/contracts/network-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { openVerifiedFileForRead } from '@agent-device/host-kit/file';

type ProcessMarkerReader = Readonly<{
  readMarker(pathname: string): Promise<AppLogProcessMarkerReadOutcome>;
}>;

export function createNetworkRuntimeHost(
  options: Readonly<{
    resolveSessionArtifacts(sessionId: string): AppLogSessionArtifacts;
    processes: ProcessMarkerReader;
    resolveTransport(device: DeviceInfo): Promise<NetworkTransport>;
  }>,
): Pick<NetworkRuntimeHost, 'appLogs' | 'networkTransports'> {
  return Object.freeze({
    appLogs: Object.freeze({
      resolveSession: options.resolveSessionArtifacts,
      readRecent: async (sessionId: string, maxScanLines: number) => {
        const { outputPath } = options.resolveSessionArtifacts(sessionId);
        return await readRecentAppLogLines(outputPath, maxScanLines);
      },
      readProcessMarker: async (sessionId: string) => {
        const { pidPath } = options.resolveSessionArtifacts(sessionId);
        return await options.processes.readMarker(pidPath);
      },
    }),
    networkTransports: Object.freeze({ resolve: options.resolveTransport }),
  });
}

const APP_LOG_READ_BLOCK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * Reads the newest `maxScanLines` lines of `app.log` block by block from its end. The prefix is only
 * counted, never decoded, so `skippedLines` keeps source line numbers absolute.
 */
export async function readRecentAppLogLines(
  pathname: string,
  maxScanLines: number,
): Promise<NetworkAppLogRead> {
  if (!Number.isInteger(maxScanLines) || maxScanLines < 1 || maxScanLines > 20_000) {
    throw new TypeError('Network app-log scan lines must be between 1 and 20000');
  }
  const descriptor = openVerifiedFileForRead(pathname);
  if (descriptor === undefined) {
    return Object.freeze({ path: pathname, exists: false, text: '', skippedLines: 0 });
  }
  try {
    const tail: Buffer[] = [];
    let position = fs.fstatSync(descriptor).size;
    let newlines = 0;
    let skippedLines = 0;
    while (position > 0) {
      const length = Math.min(APP_LOG_READ_BLOCK_BYTES, position);
      position -= length;
      const block = await readBlock(descriptor, position, length);
      const boundary = newlineFromEnd(block, maxScanLines - newlines);
      if (boundary.index === undefined) {
        newlines += boundary.count;
        tail.unshift(block);
        continue;
      }
      // The newline at `boundary.index` ends the last skipped line.
      tail.unshift(block.subarray(boundary.index + 1));
      skippedLines =
        countNewlines(block.subarray(0, boundary.index + 1)) +
        (await countNewlinesBefore(descriptor, position));
      break;
    }
    return Object.freeze({
      path: pathname,
      exists: true,
      text: Buffer.concat(tail).toString('utf8'),
      skippedLines,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

/** The index of the `wanted`-th newline from the end of `block`, or how many newlines it holds. */
function newlineFromEnd(
  block: Buffer,
  wanted: number,
): Readonly<{ index?: number; count: number }> {
  let count = 0;
  for (let index = block.length - 1; index >= 0; index -= 1) {
    if (block[index] !== NEWLINE) continue;
    count += 1;
    if (count === wanted) return { index, count };
  }
  return { count };
}

async function countNewlinesBefore(descriptor: number, end: number): Promise<number> {
  let count = 0;
  for (let position = 0; position < end; position += APP_LOG_READ_BLOCK_BYTES) {
    const length = Math.min(APP_LOG_READ_BLOCK_BYTES, end - position);
    count += countNewlines(await readBlock(descriptor, position, length));
  }
  return count;
}

function countNewlines(block: Buffer): number {
  let count = 0;
  for (let index = block.indexOf(NEWLINE); index >= 0; index = block.indexOf(NEWLINE, index + 1)) {
    count += 1;
  }
  return count;
}

async function readBlock(descriptor: number, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = await new Promise<number>((resolve, reject) => {
      fs.read(descriptor, buffer, offset, length - offset, position + offset, (error, read) =>
        error ? reject(error) : resolve(read),
      );
    });
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}
