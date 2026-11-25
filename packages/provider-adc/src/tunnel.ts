import { execFile, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { renameSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket, { createWebSocketStream } from 'ws';
import { AppError } from '@agent-device/kernel/errors';
import { adbEnvironment, adbExecutable } from './adb.ts';
import type { Attach } from './client.ts';

const exec = promisify(execFile);

export async function connectAdb(access: Attach, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  if (process.platform === 'win32')
    throw new AppError('UNSUPPORTED_OPERATION', 'ADC requires Unix domain sockets.');
  signal.throwIfAborted();
  const adb = adbExecutable(env);
  const childEnv = adbEnvironment(env);
  const directory = await mkdtemp('/tmp/agent-device-adc-');
  const devicePath = path.join(directory, 'device');
  const serverPath = path.join(directory, 'server');
  const clientPath = path.join(directory, 'client');
  const socketSpec = 'localfilesystem:' + clientPath;
  const serial = 'localfilesystem:' + devicePath;
  const sockets = new Set<Socket>();
  const closed = new AbortController();
  const fault = () =>
    closed.abort(new AppError('DEVICE_NOT_FOUND', 'ADC device connection ended.'));
  function track(socket: Socket) {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  }
  const relay = createServer((socket) => {
    track(socket);
    let ws: WebSocket;
    try {
      ws = new WebSocket(access.url, {
        headers: { Authorization: 'Bearer ' + access.token },
        handshakeTimeout: 10_000,
      });
    } catch {
      socket.destroy();
      fault();
      return;
    }
    const stream = createWebSocketStream(ws);
    stream.on('error', () => {
      if (!socket.destroyed) fault();
      socket.destroy();
    });
    ws.on('close', () => {
      if (!socket.destroyed) fault();
      socket.destroy();
    });
    socket.on('error', () => ws.terminate());
    socket.on('close', () => ws.terminate());
    socket.pipe(stream).pipe(socket);
  });
  // adb auto-starts a server on ECONNREFUSED. Its clients always reach this listener, even if
  // the foreground server dies. Retire the entire directory before closing the listener.
  const control = createServer((socket) => {
    track(socket);
    const upstream = createConnection(serverPath);
    track(upstream);
    upstream.on('error', () => {
      socket.destroy();
      fault();
    });
    socket.on('error', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  let supervisor: ChildProcess | undefined;
  let stopped: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= teardown();
    return closing;
  }
  async function teardown() {
    try {
      // The supervisor can already have retired the paths after losing its parent.
      try {
        renameSync(directory, directory + '-closed');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const listeners = [control, relay].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      );
      for (const socket of sockets) socket.destroy();
      if (supervisor?.connected) supervisor.disconnect();
      await Promise.all([...listeners, stopped]);
    } finally {
      await rm(directory + '-closed', { recursive: true, force: true });
    }
  }
  async function listen(server: Server, address: string) {
    const listening = once(server, 'listening');
    server.listen(address);
    await listening;
  }
  try {
    await listen(relay, devicePath);
    await listen(control, clientPath);
    const helper = new URL('./adb-server.mjs', import.meta.url);
    supervisor = fork(helper, [adb, directory], {
      env: childEnv,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
    });
    const group = supervisor.pid;
    stopped = once(supervisor, 'exit').then(([, termination]) => {
      // An unexpectedly killed supervisor cannot reap its foreground adb. Both belong to this group.
      if (termination && group) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      fault();
    });
    const budget = AbortSignal.any([signal, closed.signal, AbortSignal.timeout(45_000)]);
    try {
      await once(supervisor, 'message', { signal: budget });
      const run = (args: string[]) =>
        exec(adb, ['-L', socketSpec, ...args], { env: childEnv, signal: budget, timeout: 15_000 });
      await run(['connect', serial]);
      await run(['-s', serial, 'wait-for-device']);
      const result = await run(['-s', serial, 'get-state']);
      if (result.stdout.trim() !== 'device') fault();
      budget.throwIfAborted();
    } catch {
      throw new AppError('COMMAND_FAILED', 'The leased ADC device did not become ready over ADB.');
    }
    return { serial, socketSpec, closed: closed.signal, close };
  } catch (error) {
    await close();
    throw error;
  }
}
