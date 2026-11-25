import { execFile, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket, { createWebSocketStream } from 'ws';
import { AppError } from '@agent-device/kernel/errors';
import { adbExecutable } from './adb.ts';
import type { Attach } from './client.ts';

const exec = promisify(execFile);

export async function connectAdb(access: Attach, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  if (process.platform === 'win32') {
    throw new AppError('UNSUPPORTED_OPERATION', 'ADC requires a host with Unix domain sockets.');
  }
  signal.throwIfAborted();
  const adb = adbExecutable(env);
  // The enclosing directory is mode 0700. Both the bearer relay and adb's control
  // socket belong to this lease, including on hosts with a shared default adb server.
  const directory = await mkdtemp('/tmp/agent-device-adc-');
  const relayPath = path.join(directory, 'device');
  const controlPath = path.join(directory, 'server');
  const socketSpec = 'localfilesystem:' + controlPath;
  const serial = 'localfilesystem:' + relayPath;
  const serverEnv = { ...env, ADB_LOCAL_TRANSPORT_MAX_PORT: '1', ADB_MDNS_AUTO_CONNECT: '0' };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const ws = new WebSocket(access.url, {
      headers: { Authorization: `Bearer ${access.token}` },
      handshakeTimeout: 10_000,
    });
    const stream = createWebSocketStream(ws);
    stream.on('error', () => socket.destroy());
    socket.on('error', () => ws.terminate());
    socket.on('close', () => {
      sockets.delete(socket);
      ws.terminate();
    });
    stream.on('close', () => socket.destroy());
    socket.pipe(stream).pipe(socket);
  });
  let supervisor: ChildProcess | undefined;
  let stopped: Promise<unknown[]> | undefined;
  async function close() {
    try {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
      if (supervisor?.connected) supervisor.disconnect();
      await stopped;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    const listening = once(server, 'listening');
    server.listen(relayPath);
    await listening;
    const helper = new URL('./adb-server.mjs', import.meta.url);
    supervisor = fork(helper, [adb, directory], {
      env: serverEnv,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
    });
    // An explicit IPC disconnect can finish without a ChildProcess 'close' event.
    stopped = once(supervisor, 'exit');
    const startup = new AbortController();
    supervisor.once('exit', () => startup.abort(new Error('Private ADC ADB server exited.')));
    const startupSignal = AbortSignal.any([signal, startup.signal, AbortSignal.timeout(15_000)]);
    await once(supervisor, 'message', { signal: startupSignal });
    const run = (args: string[]) =>
      exec(adb, ['-L', socketSpec, ...args], { env: serverEnv, signal, timeout: 15_000 });
    await run(['connect', serial]);
    await run(['-s', serial, 'wait-for-device']);
    const result = await run(['-s', serial, 'get-state']);
    if (result.stdout.trim() !== 'device')
      throw new AppError('COMMAND_FAILED', 'ADC device did not become ready over ADB.');
    return { serial, socketSpec, close };
  } catch (error) {
    await close();
    throw error;
  }
}
