import {
  ensureAppLogPath,
  resolveAppLogRotationConfig,
  rotateAppLogIfNeeded,
} from '@agent-device/capture-kit/app-log-files';
import type { AppLogOutputSink } from '@agent-device/contracts/app-log-runtime';
import fs from 'node:fs';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { openVerifiedFileForAppend, openVerifiedFileForRead } from '@agent-device/host-kit/file';
import { requireManagedSessionArtifactPath } from '@agent-device/daemon-contracts/session-artifact-paths';

export async function openAppLogOutput(
  sessionsDir: string,
  pathname: string,
  host: HostEnvironment,
): Promise<AppLogOutputSink> {
  pathname = requireManagedOutputPath(sessionsDir, pathname);
  ensureAppLogPath(pathname, host.env);
  const rotation = resolveAppLogRotationConfig(host.env);
  let output = openAppendOutput(pathname);
  const patterns = redactionPatterns(host.env);
  let pending = '';
  let writes = Promise.resolve();
  let disposal: Promise<void> | undefined;
  const enqueue = (work: () => Promise<void>) => {
    const next = writes.then(work);
    writes = next.catch(() => undefined);
    return next;
  };
  // A sink stays open for a whole `logs start` stream, so the cap is checked as it writes. The size
  // comes from the descriptor, so `logs mark` appends through another descriptor count too.
  const rotateIfNeeded = async () => {
    if (fs.fstatSync(output.descriptor).size < rotation.maxBytes) return;
    try {
      await closeOutput(output);
      rotateAppLogIfNeeded(pathname, rotation);
    } finally {
      output = openAppendOutput(pathname);
    }
  };
  const writeText = async (text: string) => {
    const combined = `${pending}${text}`;
    const lines = combined.split('\n');
    pending = lines.pop() ?? '';
    await writeOutput(output, lines.map((line) => redact(`${line}\n`, patterns)).join(''));
    await rotateIfNeeded();
  };
  return {
    write: async (chunk) => await enqueue(async () => await writeText(decodeAppLogChunk(chunk))),
    [Symbol.asyncDispose]: async () => {
      disposal ??= enqueue(async () => {
        if (pending) {
          await writeOutput(output, redact(pending, patterns));
          pending = '';
        }
        await closeOutput(output);
        rotateAppLogIfNeeded(pathname, rotation);
      });
      await disposal;
    },
  };
}

type AppendOutput = {
  stream: fs.WriteStream;
  descriptor: number;
  error?: Error;
};

function openAppendOutput(pathname: string): AppendOutput {
  const descriptor = openVerifiedFileForAppend(pathname);
  let output: AppendOutput;
  try {
    output = {
      stream: fs.createWriteStream(pathname, { fd: descriptor, autoClose: true }),
      descriptor,
    };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
  output.stream.on('error', (error) => {
    output.error ??= error;
  });
  return output;
}

async function writeOutput(output: AppendOutput, chunk: string): Promise<void> {
  if (!chunk) return;
  await new Promise<void>((resolve, reject) => {
    output.stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

async function closeOutput(output: AppendOutput): Promise<void> {
  const { stream } = output;
  if (!stream.closed) {
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject);
      stream.end(() => {
        stream.off('error', reject);
        resolve();
      });
    });
  }
  if (output.error) throw output.error;
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

function redactionPatterns(env: NodeJS.ProcessEnv): RegExp[] {
  return (env.AGENT_DEVICE_APP_LOG_REDACT_PATTERNS ?? '')
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
