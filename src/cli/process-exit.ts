import type { Writable } from 'node:stream';
import { settleWithin } from '@agent-device/host-kit/settle-within';
import { escapeTerminalText } from '@agent-device/kernel/redaction';

const FLUSH_TIMEOUT_MS = 2000;

/**
 * `process.exit()` truncates output still queued on `process.stdout`/`stderr`:
 * Node writes to those streams synchronously only when they're a file or TTY —
 * when the CLI runs as a piped subprocess (the common case for an agent
 * driving it), writes are queued asynchronously, and `process.exit()` tears
 * the process down before a queued write reaches the pipe. A caller then sees
 * a truncated or empty final message instead of the structured error.
 * `FLUSH_TIMEOUT_MS` bounds the wait so a stalled/broken pipe still exits
 * rather than hanging the process.
 */
export async function exitAfterFlush(code: number): Promise<never> {
  await settleWithin(drainStdio, FLUSH_TIMEOUT_MS);
  process.exit(code);
}

async function drainStdio(): Promise<void> {
  await Promise.all([drainStream(process.stdout), drainStream(process.stderr)]);
}

function drainStream(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.writableLength === 0) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('drain', resolve);
  });
}

/**
 * The cli zone's stdout and stderr writes. The plain ones escape C0 (except newline and tab), DEL and C1 characters,
 * so no value a peer or a device chose can drive the terminal. The raw one is for text that already escaped its own
 * values to carry intended color. Lower zones apply the same `escapeTerminalText` themselves.
 */
export function writeStdout(text: string): void {
  process.stdout.write(escapeTerminalText(text));
}

export function writeStderr(text: string): void {
  process.stderr.write(escapeTerminalText(text));
}

type OptionalStderr = Pick<Writable, 'write'> &
  Partial<
    Pick<Writable, 'once' | 'prependOnceListener' | 'removeListener' | 'listenerCount' | 'writable'>
  >;
type StderrWriteBatch = {
  count: number;
  failedWrites: Set<Error>;
  cleanup: () => void;
};
const pendingStderrWrites = new WeakMap<OptionalStderr, StderrWriteBatch>();

/** Keep failures from optional writes from interrupting the command. */
export function writeStderrBestEffort(text: string, stream: OptionalStderr = process.stderr): void {
  if (stream.writable === false) return;
  const finish = observeStderrWrite(stream);
  try {
    if (finish) {
      stream.write(escapeTerminalText(text), finish);
    } else {
      stream.write(escapeTerminalText(text));
    }
  } catch {
    finish?.();
  }
}

function observeStderrWrite(stream: OptionalStderr): ((error?: Error | null) => void) | undefined {
  if (!stream.once || !stream.prependOnceListener || !stream.removeListener) return undefined;
  let pending = pendingStderrWrites.get(stream);
  if (!pending) {
    const failedWrites = new Set<Error>();
    const cleanup = () => {
      pendingStderrWrites.delete(stream);
      stream.removeListener?.('error', onError);
      stream.removeListener?.('close', cleanup);
    };
    const onError = (error: Error) => {
      cleanup();
      if (!failedWrites.has(error) && !stream.listenerCount?.('error')) throw error;
    };
    pending = { count: 0, failedWrites, cleanup };
    pendingStderrWrites.set(stream, pending);
    stream.prependOnceListener('error', onError);
    stream.once('close', cleanup);
  }
  const batch = pending;
  batch.count++;
  return (error) => {
    if (pendingStderrWrites.get(stream) !== batch) return;
    // A failed Writable invokes the write callback before emitting error or close.
    if (error) batch.failedWrites.add(error);
    else if (--batch.count === 0) batch.cleanup();
  };
}

export function writeStdoutRaw(text: string): void {
  process.stdout.write(text);
}
