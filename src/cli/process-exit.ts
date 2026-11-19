import { settleWithin } from '@agent-device/host-kit/retry';
import { escapeTerminalText } from '@agent-device/kernel/success-text';

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
 * The CLI's stdout and stderr writes. Every CLI write goes through one of these: the plain ones escape C0 (except
 * newline and tab), DEL and C1 characters, so no value a peer or a device chose can drive the terminal. The raw ones
 * are for text that already escaped its own values to carry intended color, and for another program's output the
 * CLI passes through unchanged.
 */
export function writeStdout(text: string): void {
  process.stdout.write(escapeTerminalText(text));
}

export function writeStderr(text: string): void {
  process.stderr.write(escapeTerminalText(text));
}

export function writeStdoutRaw(text: string | Uint8Array): void {
  process.stdout.write(text);
}

export function writeStderrRaw(text: string | Uint8Array): void {
  process.stderr.write(text);
}
