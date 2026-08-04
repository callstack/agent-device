import { sleep } from './timeouts.ts';

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
  await Promise.race([drainStdio(), sleep(FLUSH_TIMEOUT_MS)]);
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
