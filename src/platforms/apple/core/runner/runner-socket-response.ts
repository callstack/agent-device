import { type Socket } from 'node:net';
import { createRequestCanceledError } from '../../../../request/cancel.ts';

export type SocketReadResult<T> = { value: T } | { error: Error } | undefined;

export async function readSocketResponse<T>(options: {
  socket: Socket;
  timeoutMs: number;
  signal?: AbortSignal;
  timeoutError: () => Error;
  closedError: () => Error;
  select: (buffer: Buffer) => SocketReadResult<T>;
  completion: 'pause' | 'destroy';
}): Promise<T> {
  if (options.signal?.aborted) throw createRequestCanceledError();
  return await new Promise<T>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish({ error: options.timeoutError() }), options.timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const result = options.select(buffer);
        if (result) finish(result);
      } catch (error) {
        finish({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    };
    const onError = (error: Error) => finish({ error });
    const onClose = () => finish({ error: options.closedError() });
    const onAbort = () => finish({ error: createRequestCanceledError() });
    const finish = (result: Exclude<SocketReadResult<T>, undefined>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.socket.off('data', onData);
      options.socket.off('error', onError);
      options.socket.off('close', onClose);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.completion === 'destroy') options.socket.destroy();
      else options.socket.pause();
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };
    options.socket.on('data', onData);
    options.socket.once('error', onError);
    options.socket.once('close', onClose);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    options.socket.resume();
  });
}
