import { once } from 'node:events';
import { connect, getDefaultAutoSelectFamilyAttemptTimeout, type Socket } from 'node:net';
import type { ReadableStream } from 'node:stream/web';
import { parentPort } from 'node:worker_threads';
import { Agent, fetch } from 'undici';

export type LoopbackDownloadRequest = {
  url: string;
  token: string;
  addresses: string[];
};

export type LoopbackDownloadReply =
  | { status: number; body?: ReadableStream<Uint8Array> }
  | { failed: true };

async function connectInOrder(addresses: string[], port: number): Promise<Socket> {
  for (const [index, address] of addresses.entries()) {
    const socket = connect({ host: address, port });
    const signal =
      index < addresses.length - 1
        ? AbortSignal.timeout(getDefaultAutoSelectFamilyAttemptTimeout())
        : undefined;
    try {
      await once(socket, 'connect', { signal });
      return socket;
    } catch {
      socket.destroy();
    }
  }
  throw new Error('Loopback connection failed');
}

const port = parentPort;
if (!port) throw new Error('Loopback download requires a worker');

try {
  const [request] = (await once(port, 'message')) as [LoopbackDownloadRequest];
  // The caller owns the deadline and terminates this worker after the body finishes.
  port.ref();
  const { url, token, addresses } = request;
  const dispatcher = new Agent({
    connect: (options, callback) => {
      void connectInOrder(addresses, Number(options.port || 80)).then(
        (socket) => callback(null, socket),
        () => callback(new Error('Loopback connection failed'), null),
      );
    },
  });
  const response = await fetch(url, {
    dispatcher,
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  });
  // Only successful responses can send a body to the caller.
  const body = response.ok ? response.body : null;
  if (body)
    port.postMessage({ status: response.status, body } satisfies LoopbackDownloadReply, [body]);
  else port.postMessage({ status: response.status } satisfies LoopbackDownloadReply);
} catch {
  port.postMessage({ failed: true } satisfies LoopbackDownloadReply);
}
