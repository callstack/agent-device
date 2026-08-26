import type { AppLogOutputSink } from '@agent-device/contracts/app-log-runtime';
import fs from 'node:fs';
import { ensureAppLogPath } from './utils/app-log-files.ts';
import { requireManagedSessionArtifactPath } from './utils/managed-session-artifact-path.ts';
import { openVerifiedFileForAppend, openVerifiedFileForRead } from './utils/verified-file.ts';

export async function openAppLogOutput(
  sessionsDir: string,
  pathname: string,
): Promise<AppLogOutputSink> {
  pathname = requireManagedOutputPath(sessionsDir, pathname);
  ensureAppLogPath(pathname);
  const descriptor = openVerifiedFileForAppend(pathname);
  let stream: fs.WriteStream;
  try {
    stream = fs.createWriteStream(pathname, { fd: descriptor, autoClose: true });
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
  let streamError: Error | undefined;
  stream.on('error', (error) => {
    streamError ??= error;
  });
  const patterns = redactionPatterns();
  let pending = '';
  let writes = Promise.resolve();
  let disposal: Promise<void> | undefined;
  const enqueue = (work: () => Promise<void>) => {
    const next = writes.then(work);
    writes = next.catch(() => undefined);
    return next;
  };
  const writeText = async (text: string) => {
    const combined = `${pending}${text}`;
    const lines = combined.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) await writeChunk(stream, redact(`${line}\n`, patterns));
  };
  return {
    write: async (chunk) => await enqueue(async () => await writeText(decodeAppLogChunk(chunk))),
    [Symbol.asyncDispose]: async () => {
      disposal ??= enqueue(async () => {
        if (pending) {
          await writeChunk(stream, redact(pending, patterns));
          pending = '';
        }
        await closeStream(stream);
        if (streamError) throw streamError;
      });
      await disposal;
    },
  };
}

export async function readAppLogOutputTail(
  sessionsDir: string,
  pathname: string,
  maxBytes: number,
): Promise<string> {
  pathname = requireManagedOutputPath(sessionsDir, pathname);
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new TypeError('App-log tail size must be between 1 byte and 1 MiB');
  }
  const handle = openVerifiedFileForRead(pathname);
  if (handle === undefined) return '';
  const size = fs.fstatSync(handle).size;
  const length = Math.min(size, maxBytes);
  const start = size - length;
  const prefixLength = start > 0 ? 1 : 0;
  const buffer = Buffer.alloc(length + prefixLength);
  try {
    fs.readSync(handle, buffer, 0, buffer.length, start - prefixLength);
  } finally {
    fs.closeSync(handle);
  }
  const decoded = buffer.subarray(prefixLength).toString('utf8');
  if (prefixLength === 0 || buffer[0] === 0x0a) return decoded;
  const firstCompleteLine = decoded.indexOf('\n');
  return firstCompleteLine < 0 ? '' : decoded.slice(firstCompleteLine + 1);
}

function requireManagedOutputPath(sessionsDir: string, pathname: string): string {
  return requireManagedSessionArtifactPath({
    sessionsDir,
    pathname,
    basename: 'app.log',
    label: 'App-log output',
  });
}

function redactionPatterns(): RegExp[] {
  return (process.env.AGENT_DEVICE_APP_LOG_REDACT_PATTERNS ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((pattern) => {
      try {
        return [new RegExp(pattern, 'gi')];
      } catch {
        return [];
      }
    });
}

function redact(chunk: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((output, pattern) => output.replace(pattern, '[REDACTED]'), chunk);
}

function decodeAppLogChunk(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

async function writeChunk(stream: fs.WriteStream, chunk: string): Promise<void> {
  if (!chunk) return;
  await new Promise<void>((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

async function closeStream(stream: fs.WriteStream): Promise<void> {
  if (stream.closed) return;
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => {
      stream.off('error', reject);
      resolve();
    });
  });
}
