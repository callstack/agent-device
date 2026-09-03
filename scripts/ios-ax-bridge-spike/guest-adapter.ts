import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { DEFAULT_SPIKE_LIMITS, validateRawAcquisition } from './limits.ts';
import { failureResponse } from './protocol.ts';
import { processUsageDelta, readGuestProcessSample } from './guest-process-metrics.ts';
import {
  acquisitionFromEnvelope,
  encodeGuestFrame,
  failureFromEnvelope,
  GuestFrameDecoder,
  guestDescribeRequest,
  GuestWireError,
  isTargetNotReady,
  type GuestEnvelope,
} from './guest-wire.ts';
import type { AcquisitionAdapter, AdapterOptions } from './adapter.ts';
import type {
  GuestMechanismEvidence,
  ResourceLimits,
  SpikeFailure,
  SpikeRequest,
  SpikeResponse,
} from './types.ts';

const CANDIDATE = 'guest-simulator-framework-bridge' as const;

/** Idle window after which an orphaned guest ends itself; the host never relies on it for teardown. */
const GUEST_IDLE_TIMEOUT_SECONDS = 300;
/** Bounded wait for a target whose accessibility server is still registering (fresh launch). */
const TARGET_NOT_READY_RETRY_MS = 150;
const TARGET_NOT_READY_RETRIES = 2;
const CONNECT_POLL_MS = 15;

export const GUEST_MECHANISM_EVIDENCE: GuestMechanismEvidence = {
  implementation: 'idb',
  release: 'v1.5.2',
  companionArchive: 'idb-companion.macos-arm64.tar.gz',
  companionSha256: 'f17b718a513931705542a7fbfa9cfc11895ee191562c9ffd2343cf7f8254bc08',
  guestBinary: 'Resources/SimulatorFrameworkBridge',
  guestBinarySha256: '3545621d2dc98de32879ebac55e8b0c33dc8eb7cc2bfbc2d0d2d21a002c8de58',
  transport:
    'xcrun simctl spawn <udid> SimulatorFrameworkBridge accessibility serve <socket> --idle-timeout 300 --exit-on-disconnect true; UNIX socket frames are a 4-byte big-endian length + JSON',
  traversal:
    'describe with snapshotTree=true (one XCTest snapshot fetch per read) and automationMode=true asserted per request; no idb_companion, gRPC, or Python client',
  client: 'node-direct-socket',
};

export function createGuestSimulatorFrameworkBridgeAdapter(
  options: AdapterOptions,
): AcquisitionAdapter {
  const limits = options.limits ?? DEFAULT_SPIKE_LIMITS;
  if (!options.guestBridge || !fs.existsSync(options.guestBridge)) {
    return unavailableAdapter('guest-tool-unavailable');
  }
  const session = new GuestSession(options.guestBridge, limits);
  return {
    candidate: CANDIDATE,
    acquireBatch: (requests, acquireOptions) => session.acquireBatch(requests, acquireOptions),
    close: () => session.close(),
    evidence: {
      terminateReaderOnNextBatch: () => session.killGuestOnNextRequestForEvidence(),
    },
  };
}

function unavailableAdapter(code: string): AcquisitionAdapter {
  return {
    candidate: CANDIDATE,
    async acquireBatch(requests) {
      return {
        responses: requests.map((request) =>
          failureResponse(request, { kind: 'unsupported-mechanism', code }),
        ),
        stderr: '',
      };
    },
  };
}

class GuestError extends Error {
  readonly kind: SpikeFailure['kind'];
  readonly code: string;

  constructor(kind: SpikeFailure['kind'], code: string) {
    super(`${kind}/${code}`);
    this.name = 'GuestError';
    this.kind = kind;
    this.code = code;
  }
}

type Pending = Readonly<{
  resolve: (frame: Buffer) => void;
  reject: (error: GuestError) => void;
}>;

/**
 * One guest `accessibility serve` process per session, spawned into the Simulator's launchd domain
 * through `simctl spawn`, reached over a private UNIX socket, and held for the session. The guest is
 * private to this host (`--exit-on-disconnect`), so dropping the socket is the whole teardown; the
 * next request respawns.
 */
class GuestSession {
  private readonly socketPath = path.join(
    socketDirectory(),
    `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}.sock`,
  );
  private child?: ChildProcess;
  private socket?: net.Socket;
  private decoder = new GuestFrameDecoder();
  private pending?: Pending;
  private udid?: string;
  private log = '';
  private closed = false;
  private killNext = false;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly bridgePath: string;
  private readonly limits: ResourceLimits;

  constructor(bridgePath: string, limits: ResourceLimits) {
    this.bridgePath = bridgePath;
    this.limits = limits;
  }

  acquireBatch(
    requests: readonly SpikeRequest[],
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<{ responses: readonly SpikeResponse[]; stderr: string }> {
    const operation = this.serial.then(() => this.execute(requests, options.signal));
    this.serial = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.dropConnection(new GuestError('cancelled', 'process-closed'));
    await this.reapChild();
    fs.rmSync(this.socketPath, { force: true });
  }

  killGuestOnNextRequestForEvidence(): void {
    this.killNext = true;
  }

  private async execute(
    requests: readonly SpikeRequest[],
    signal: AbortSignal | undefined,
  ): Promise<{ responses: readonly SpikeResponse[]; stderr: string }> {
    const responses: SpikeResponse[] = [];
    for (const request of requests) {
      // Each request carries its own bounds; the deadline is the request's duration budget, so a
      // caller can shorten one read (the timeout probe) without reshaping the session.
      const deadline = performance.now() + request.limits.maxDurationMs;
      responses.push(await this.acquire(request, deadline, signal));
    }
    return { responses, stderr: this.takeLog() };
  }

  private async acquire(
    request: SpikeRequest,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<SpikeResponse> {
    const started = performance.now();
    const frame = encodeGuestFrame(guestDescribeRequest(request, request.limits));
    if (frame.length > request.limits.maxRequestBytes) {
      return failureResponse(request, {
        kind: 'transport-failure',
        code: 'request-limit-exceeded',
      });
    }
    try {
      return await this.acquireConnected(request, frame, deadline, started, signal);
    } catch (error) {
      return failedGuestRequest(request, frame.length, started, error);
    }
  }

  private async acquireConnected(
    request: SpikeRequest,
    frame: Buffer,
    deadline: number,
    started: number,
    signal: AbortSignal | undefined,
  ): Promise<SpikeResponse> {
    assertRequestActive(signal, this.closed);
    const wasConnected = this.socket !== undefined && !this.socket.destroyed;
    await this.ensureConnected(request.simulatorUdid, deadline, signal);
    const before = wasConnected ? readGuestProcessSample(this.socketPath) : undefined;
    const { envelope, responseBytes } = await this.readWithReadinessRetry(frame, deadline, signal);
    const resources = processUsageDelta(before, readGuestProcessSample(this.socketPath));
    return this.responseFor(request, envelope, {
      requestBytes: frame.length,
      responseBytes,
      durationMs: performance.now() - started,
      cpuMs: resources?.cpuMs ?? null,
      memoryBytes: resources?.memoryBytes ?? null,
    });
  }

  private async readWithReadinessRetry(
    frame: Buffer,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<{ envelope: GuestEnvelope; responseBytes: number }> {
    let attempt = await this.roundTrip(frame, deadline, signal);
    for (let retry = 0; retry < TARGET_NOT_READY_RETRIES; retry += 1) {
      if (attempt.envelope.ok === true || !isTargetNotReady(attempt.envelope)) break;
      if (performance.now() + TARGET_NOT_READY_RETRY_MS * 2 > deadline) break;
      await sleep(TARGET_NOT_READY_RETRY_MS);
      attempt = await this.roundTrip(frame, deadline, signal);
    }
    return attempt;
  }

  private responseFor(
    request: SpikeRequest,
    envelope: GuestEnvelope,
    metrics: {
      requestBytes: number;
      responseBytes: number;
      durationMs: number;
      cpuMs: number | null;
      memoryBytes: number | null;
    },
  ): SpikeResponse {
    if (envelope.ok !== true) {
      return failureResponse(
        request,
        failureFromEnvelope(envelope, request, processAlive),
        metrics,
      );
    }
    const parsed = acquisitionFromEnvelope(envelope, request, request.limits);
    if ('kind' in parsed) return failureResponse(request, parsed, metrics);
    const validated = validateRawAcquisition(parsed.acquisition, request.limits);
    if (!validated.ok) {
      return failureResponse(request, { kind: 'malformed-tree', code: validated.code }, metrics);
    }
    const resourceFailure = resourceLimitFailure(metrics, request.limits);
    if (resourceFailure) return failureResponse(request, resourceFailure, metrics);
    return {
      version: 1,
      id: request.id,
      candidate: request.candidate,
      ok: true,
      acquisition: parsed.acquisition,
      metrics: {
        ...metrics,
        nodeCount: parsed.acquisition.nodes.length,
        maxTraversalDepth: validated.maxTraversalDepth,
      },
    };
  }

  private async ensureConnected(
    udid: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      if (this.udid !== udid) throw new GuestError('transport-failure', 'guest-udid-changed');
      return;
    }
    this.udid = udid;
    this.spawnGuest(udid);
    this.socket = await this.connect(deadline, signal);
    this.decoder = new GuestFrameDecoder(this.limits.maxResponseBytes);
    const socket = this.socket;
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.failPending(new GuestError('process-crash', 'guest-exited'));
    });
    socket.on('error', () => {
      this.failPending(new GuestError('transport-failure', 'guest-socket-error'));
    });
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
          this.reapChild();
          reject(new GuestError('cancelled', 'abort-signal'));
          return;
        }
        if (performance.now() > deadline) {
          this.reapChild();
          reject(new GuestError('timeout', 'guest-connect-timeout'));
          return;
        }
        if (!this.child) {
          reject(new GuestError('transport-failure', 'guest-exited-before-ready'));
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

  private roundTrip(
    frame: Buffer,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<{ envelope: GuestEnvelope; responseBytes: number }> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket) {
        reject(new GuestError('transport-failure', 'guest-not-connected'));
        return;
      }
      const timer = setTimeout(
        () => this.dropConnection(new GuestError('timeout', 'batch-duration-limit')),
        Math.max(0, deadline - performance.now()),
      );
      const onAbort = (): void => this.dropConnection(new GuestError('cancelled', 'abort-signal'));
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
            reject(new GuestError('malformed-tree', 'invalid-json'));
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

  private consume(chunk: Buffer): void {
    let frames: Buffer[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      const wire = error instanceof GuestWireError ? error : undefined;
      this.dropConnection(
        new GuestError(wire?.kind ?? 'malformed-tree', wire?.code ?? 'frame-limit-exceeded'),
      );
      return;
    }
    for (const frame of frames) {
      const pending = this.pending;
      this.pending = undefined;
      if (pending) pending.resolve(frame);
    }
  }

  private failPending(error: GuestError): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  private dropConnection(error: GuestError): void {
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

  private takeLog(): string {
    const log = this.log;
    this.log = '';
    return log;
  }
}

/** A private, owner-only directory beneath the per-user temporary directory keeps `sun_path` short. */
function socketDirectory(): string {
  const directory = path.join(os.tmpdir(), 'agent-device-ax');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (directory.length + 24 >= 104) {
    throw new Error(`Socket directory path is too long for a UNIX socket: ${directory}`);
  }
  return directory;
}

/** The guest is parented to launchd_sim, not to this process; it is addressed by its socket argv. */
function killGuestProcesses(socketPath: string): void {
  const found = spawnSync('pgrep', ['-f', `accessibility serve ${socketPath}`], {
    encoding: 'utf8',
  });
  for (const line of (found.stdout ?? '').split('\n')) {
    const pid = Number(line.trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function asGuestError(error: unknown): GuestError {
  if (error instanceof GuestError) return error;
  if (error instanceof GuestWireError) return new GuestError(error.kind, error.code);
  return new GuestError('transport-failure', 'guest-unexpected-error');
}

function assertRequestActive(signal: AbortSignal | undefined, closed: boolean): void {
  if (signal?.aborted) throw new GuestError('cancelled', 'abort-signal');
  if (closed) throw new GuestError('transport-failure', 'guest-adapter-closed');
}

function failedGuestRequest(
  request: SpikeRequest,
  requestBytes: number,
  started: number,
  error: unknown,
): SpikeResponse {
  const guestError = asGuestError(error);
  return failureResponse(
    request,
    { kind: guestError.kind, code: guestError.code },
    { requestBytes, durationMs: performance.now() - started },
  );
}

function resourceLimitFailure(
  metrics: { cpuMs: number | null; memoryBytes: number | null },
  limits: ResourceLimits,
): SpikeFailure | undefined {
  if (metrics.cpuMs !== null && metrics.cpuMs > limits.maxCpuMs) {
    return { kind: 'transport-failure', code: 'cpu-limit-exceeded' };
  }
  if (metrics.memoryBytes !== null && metrics.memoryBytes > limits.maxMemoryBytes) {
    return { kind: 'transport-failure', code: 'memory-limit-exceeded' };
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
