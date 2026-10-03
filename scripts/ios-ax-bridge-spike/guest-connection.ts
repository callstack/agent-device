import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readGuestProcessSample, type GuestProcessSample } from './guest-process-metrics.ts';
import { GuestFrameDecoder, GuestWireError, type GuestEnvelope } from './guest-wire.ts';
import type { SpikeFailure } from './types.ts';

const GUEST_IDLE_TIMEOUT_SECONDS = 300;
const CONNECT_POLL_MS = 15;

type Pending = Readonly<{
  resolve: (frame: Buffer) => void;
  reject: (error: GuestConnectionError) => void;
}>;

export class GuestConnectionError extends Error {
  readonly kind: SpikeFailure['kind'];
  readonly code: string;

  constructor(kind: SpikeFailure['kind'], code: string) {
    super(`${kind}/${code}`);
    this.name = 'GuestConnectionError';
    this.kind = kind;
    this.code = code;
  }
}

export class GuestConnection {
  private readonly bridgePath: string;
  private readonly maxResponseBytes: number;
  private readonly socketPath = path.join(
    socketDirectory(),
    `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}.sock`,
  );
  private child?: ChildProcess;
  private socket?: net.Socket;
  private decoder: GuestFrameDecoder;
  private pending?: Pending;
  private udid?: string;
  private log = '';
  private killNext = false;

  constructor(bridgePath: string, maxResponseBytes: number) {
    this.bridgePath = bridgePath;
    this.maxResponseBytes = maxResponseBytes;
    this.decoder = new GuestFrameDecoder(maxResponseBytes);
  }

  async ensureConnected(
    udid: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (this.socket && !this.socket.destroyed) {
      if (this.udid !== udid) {
        throw new GuestConnectionError('transport-failure', 'guest-udid-changed');
      }
      return true;
    }
    this.udid = udid;
    this.spawnGuest(udid);
    this.socket = await this.connect(deadline, signal);
    this.decoder = new GuestFrameDecoder(this.maxResponseBytes);
    const socket = this.socket;
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.failPending(new GuestConnectionError('process-crash', 'guest-exited'));
    });
    socket.on('error', () => {
      this.failPending(new GuestConnectionError('transport-failure', 'guest-socket-error'));
    });
    return false;
  }

  processSample(): GuestProcessSample | undefined {
    return readGuestProcessSample(this.socketPath);
  }

  roundTrip(
    frame: Buffer,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<{ envelope: GuestEnvelope; responseBytes: number }> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket) {
        reject(new GuestConnectionError('transport-failure', 'guest-not-connected'));
        return;
      }
      const timer = setTimeout(
        () => this.drop(new GuestConnectionError('timeout', 'batch-duration-limit')),
        Math.max(0, deadline - performance.now()),
      );
      const onAbort = (): void => this.drop(new GuestConnectionError('cancelled', 'abort-signal'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const settle = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.pending = {
        resolve: (body) => {
          settle();
          try {
            resolve({
              envelope: JSON.parse(body.toString('utf8')) as GuestEnvelope,
              responseBytes: body.length + 4,
            });
          } catch {
            reject(new GuestConnectionError('malformed-tree', 'invalid-json'));
          }
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      };
      socket.write(frame);
      if (this.killNext) {
        this.killNext = false;
        killGuestProcesses(this.socketPath);
      }
    });
  }

  killOnNextRequest(): void {
    this.killNext = true;
  }

  takeLog(): string {
    const log = this.log;
    this.log = '';
    return log;
  }

  async close(): Promise<void> {
    this.drop(new GuestConnectionError('cancelled', 'process-closed'));
    await this.reapChild();
    fs.rmSync(this.socketPath, { force: true });
  }

  private spawnGuest(udid: string): void {
    fs.rmSync(this.socketPath, { force: true });
    const child = spawn(
      'xcrun',
      [
        'simctl',
        'spawn',
        udid,
        this.bridgePath,
        'accessibility',
        'serve',
        this.socketPath,
        '--idle-timeout',
        String(GUEST_IDLE_TIMEOUT_SECONDS),
        '--exit-on-disconnect',
        'true',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(chunk));
    child.on('error', (error) => this.appendLog(Buffer.from(`${error.message}\n`)));
    child.on('exit', () => {
      if (this.child === child) this.child = undefined;
    });
    this.child = child;
  }

  private connect(deadline: number, signal: AbortSignal | undefined): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const attempt = (): void => {
        if (signal?.aborted) {
          void this.reapChild();
          reject(new GuestConnectionError('cancelled', 'abort-signal'));
          return;
        }
        if (performance.now() > deadline) {
          void this.reapChild();
          reject(new GuestConnectionError('timeout', 'guest-connect-timeout'));
          return;
        }
        if (!this.child) {
          reject(new GuestConnectionError('transport-failure', 'guest-exited-before-ready'));
          return;
        }
        const socket = net.createConnection(this.socketPath);
        socket.once('connect', () => {
          socket.removeAllListeners('error');
          resolve(socket);
        });
        socket.once('error', () => {
          socket.destroy();
          setTimeout(attempt, CONNECT_POLL_MS);
        });
      };
      attempt();
    });
  }

  private consume(chunk: Buffer): void {
    let frames: Buffer[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      const wire = error instanceof GuestWireError ? error : undefined;
      this.drop(
        new GuestConnectionError(
          wire?.kind ?? 'malformed-tree',
          wire?.code ?? 'frame-limit-exceeded',
        ),
      );
      return;
    }
    for (const frame of frames) {
      const pending = this.pending;
      this.pending = undefined;
      pending?.resolve(frame);
    }
  }

  private failPending(error: GuestConnectionError): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  private drop(error: GuestConnectionError): void {
    this.failPending(error);
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    killGuestProcesses(this.socketPath);
  }

  private async reapChild(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(1_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  private appendLog(chunk: Buffer): void {
    if (this.log.length >= 64 * 1024) return;
    this.log += chunk.toString('utf8').slice(0, 64 * 1024 - this.log.length);
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function socketDirectory(): string {
  const directory = path.join(os.tmpdir(), 'agent-device-ax');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (directory.length + 24 >= 104) {
    throw new Error(`Socket directory path is too long for a UNIX socket: ${directory}`);
  }
  return directory;
}

function killGuestProcesses(socketPath: string): void {
  const found = spawnSync('pgrep', ['-f', `accessibility serve ${socketPath}`], {
    encoding: 'utf8',
  });
  for (const line of (found.stdout ?? '').split('\n')) {
    const pid = Number(line.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
