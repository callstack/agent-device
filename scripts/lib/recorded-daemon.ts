import net from 'node:net';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { readDaemonRecord } from '@agent-device/daemon-contracts/daemon-resolution';
import { isDaemonProgressEnvelope } from '@agent-device/daemon-contracts/request-progress-protocol';
import type { DaemonResponse } from '@agent-device/kernel/contracts';

/**
 * The daemon a state directory records, as the measurement and live-lane tooling reads it.
 * These callers observe or drive a daemon another build started and must not start, replace or
 * compatibility-check it, which the daemon-client transport always does.
 */
export type RecordedDaemon = Readonly<{
  pid: number;
  token: string;
  port?: number;
  httpPort?: number;
  processStartTime?: string;
}>;

export function readRecordedDaemon(infoPath: string): RecordedDaemon | null {
  const read = readDaemonRecord(infoPath);
  if (read.status !== 'present') return null;
  const { pid, token, port, httpPort, processStartTime } = read.record;
  if (typeof pid !== 'number' || typeof token !== 'string') return null;
  return {
    pid,
    token,
    ...(typeof port === 'number' ? { port } : {}),
    ...(typeof httpPort === 'number' ? { httpPort } : {}),
    ...(typeof processStartTime === 'string' ? { processStartTime } : {}),
  };
}

/**
 * One request to the recorded daemon: over its socket when it records one, answered by the
 * response line after any progress, otherwise over its HTTP `/rpc` endpoint.
 */
export async function sendToRecordedDaemon(
  daemon: RecordedDaemon,
  request: Omit<DaemonWireRequest, 'token'>,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<DaemonResponse> {
  const { port } = daemon;
  if (port === undefined) return await sendOverHttp(daemon, request, options);
  return await new Promise<DaemonResponse>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(
      () => fail(new Error(`Daemon request timed out after ${options.timeoutMs}ms.`)),
      options.timeoutMs,
    );
    const fail = (error: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    options.signal?.addEventListener('abort', () => fail(options.signal?.reason), { once: true });
    socket.setEncoding('utf8');
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ ...request, token: daemon.token })}\n`),
    );
    socket.on('error', fail);
    let buffered = '';
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        const message: unknown = JSON.parse(line);
        if (isDaemonProgressEnvelope(message)) continue;
        clearTimeout(timer);
        socket.end();
        resolve(message as DaemonResponse);
        return;
      }
    });
    socket.on('end', () => fail(new Error('Daemon closed the connection without a response.')));
  });
}

async function sendOverHttp(
  daemon: RecordedDaemon,
  request: Omit<DaemonWireRequest, 'token'>,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<DaemonResponse> {
  if (daemon.httpPort === undefined) throw new Error(`Daemon ${daemon.pid} records no endpoint.`);
  const signal = AbortSignal.timeout(options.timeoutMs);
  const response = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: request.meta?.requestId ?? `recorded-${Date.now()}`,
      method: 'agent_device.command',
      params: { ...request, token: daemon.token },
    }),
    signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
  });
  const envelope = (await response.json()) as {
    result?: DaemonResponse;
    error?: { message: string };
  };
  if (!envelope.result) throw new Error(envelope.error?.message ?? 'Daemon returned no result.');
  return envelope.result;
}
