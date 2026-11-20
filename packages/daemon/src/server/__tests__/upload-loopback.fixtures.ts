import fs from 'node:fs';
import type http from 'node:http';
import type net from 'node:net';
import { vi } from 'vitest';

/**
 * Observes the server's own answers, so a test waits on the server's state instead of
 * counting event-loop turns: `admitted(path)` resolves when the next request for exactly
 * that path (query aside) reaches the route callback, and `answered(path)` when the server
 * has ended its response (written, or queued behind an earlier pipelined answer).
 */
export function watchServer(server: http.Server) {
  const admitted = new Map<string, Array<() => void>>();
  const answered = new Map<string, Array<() => void>>();
  const seen = { admitted: [] as string[], answered: [] as string[] };
  const notify = (map: Map<string, Array<() => void>>, list: string[], url: string) => {
    list.push(url);
    for (const [path, waiters] of map) {
      if (url.split('?')[0] !== path || waiters.length === 0) continue;
      waiters.shift()?.();
      return;
    }
  };
  const closed: Array<Promise<void>> = [];
  server.on('connection', (socket: net.Socket) => {
    closed.push(new Promise<void>((resolve) => socket.once('close', () => resolve())));
  });
  server.prependListener('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? '';
    notify(admitted, seen.admitted, url);
    const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
    let ended = false;
    res.end = ((...args: unknown[]) => {
      const result = end(...args);
      if (!ended) {
        ended = true;
        notify(answered, seen.answered, url);
      }
      return result;
    }) as typeof res.end;
  });
  const waitFor = (map: Map<string, Array<() => void>>, path: string) =>
    new Promise<void>((resolve) => {
      const waiters = map.get(path) ?? [];
      waiters.push(resolve);
      map.set(path, waiters);
    });
  return {
    admitted: (path: string) => waitFor(admitted, path),
    answered: (path: string) => waitFor(answered, path),
    /** Resolves when every server-side connection accepted so far has closed. */
    connectionsClosed: () => Promise.all(closed).then(() => undefined),
  };
}

export type ParsedResponse = { status: number; headers: Record<string, string>; body: string };

/**
 * Collects the HTTP/1.1 responses a raw client socket receives. `responses(count)` resolves
 * once that many responses are complete (headers plus a Content-Length body), whatever the
 * TCP chunking, and rejects when a reset or the server's FIN arrives first; `ended` resolves on
 * the server's FIN; `errors` records any reset.
 */
export function readResponses(socket: net.Socket) {
  let buffer = '';
  const parsed: ParsedResponse[] = [];
  const waiters: Array<{
    count: number;
    resolve: (responses: ParsedResponse[]) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const errors: unknown[] = [];
  let finished: Error | undefined;
  // A reset or a FIN before the awaited responses is the failure to report, not a 3 s wait.
  const fail = (reason: Error): void => {
    finished ??= reason;
    for (const waiter of waiters.splice(0)) waiter.reject(reason);
  };
  const parse = () => {
    for (;;) {
      const next = parseOneResponse(buffer);
      if (!next) return;
      parsed.push(next.response);
      buffer = buffer.slice(next.consumed);
    }
  };
  socket.on('data', (data: Buffer) => {
    buffer += data.toString('latin1');
    parse();
    for (const waiter of waiters.slice()) {
      if (parsed.length < waiter.count) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(parsed.slice(0, waiter.count));
    }
  });
  socket.on('error', (error) => {
    errors.push(error);
    fail(error);
  });
  const ended = new Promise<void>((resolve) => socket.once('end', () => resolve()));
  socket.once('end', () =>
    fail(new Error(`the connection ended after ${parsed.length} complete response(s)`)),
  );
  return {
    errors,
    ended,
    responses: (count: number) => {
      if (parsed.length >= count) return Promise.resolve(parsed.slice(0, count));
      if (finished) return Promise.reject(finished);
      return new Promise<ParsedResponse[]>((resolve, reject) =>
        waiters.push({ count, resolve, reject }),
      );
    },
  };
}

/**
 * Counts the body bytes a single-shot upload has written to its artifact file, so a test
 * moves the fake clock only after the server accepted the progress it just sent.
 */
export function watchAcceptedArtifactBytes(fileName: string) {
  let accepted = 0;
  const waiters: Array<{ bytes: number; resolve: () => void }> = [];
  const createWriteStream = fs.createWriteStream;
  const spy = vi.spyOn(fs, 'createWriteStream').mockImplementation((path, options) => {
    if (!String(path).endsWith(`/${fileName}`)) return createWriteStream(path, options);
    return createWriteStream(path, {
      ...(typeof options === 'object' ? options : {}),
      fs: {
        open: fs.open,
        close: fs.close,
        write(fd, buffer, offset, length, position, callback) {
          fs.write(fd, buffer, offset, length, position, (error, written, data) => {
            if (!error) {
              accepted += written;
              for (const waiter of waiters.slice()) {
                if (accepted < waiter.bytes) continue;
                waiters.splice(waiters.indexOf(waiter), 1);
                waiter.resolve();
              }
            }
            callback(error, written, data);
          });
        },
      },
    });
  });
  return {
    reached: (bytes: number) =>
      accepted >= bytes
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ bytes, resolve })),
    restore: () => spy.mockRestore(),
  };
}

/** Parses one complete response from the front of `buffer`, or undefined while it is partial. */
function parseOneResponse(
  buffer: string,
): { response: ParsedResponse; consumed: number } | undefined {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return undefined;
  const [statusLine = '', ...lines] = buffer.slice(0, headerEnd).split('\r\n');
  const headers = parseHeaderLines(lines);
  const bodyStart = headerEnd + 4;
  const body =
    headers['transfer-encoding'] === 'chunked'
      ? readChunkedBody(buffer, bodyStart)
      : readLengthBody(buffer, bodyStart, Number(headers['content-length'] ?? '0'));
  if (!body) return undefined;
  return {
    response: { status: Number(statusLine.split(' ')[1]), headers, body: body.text },
    consumed: body.end,
  };
}

function parseHeaderLines(lines: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function readLengthBody(
  buffer: string,
  start: number,
  length: number,
): { text: string; end: number } | undefined {
  if (buffer.length < start + length) return undefined;
  return { text: buffer.slice(start, start + length), end: start + length };
}

function readChunkedBody(buffer: string, start: number): { text: string; end: number } | undefined {
  let text = '';
  let cursor = start;
  for (;;) {
    const sizeEnd = buffer.indexOf('\r\n', cursor);
    if (sizeEnd === -1) return undefined;
    const size = Number.parseInt(buffer.slice(cursor, sizeEnd), 16);
    if (buffer.length < sizeEnd + 2 + size + 2) return undefined;
    text += buffer.slice(sizeEnd + 2, sizeEnd + 2 + size);
    cursor = sizeEnd + 2 + size + 2;
    if (size === 0) return { text, end: cursor };
  }
}
