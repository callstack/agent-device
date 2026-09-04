import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sleep } from '@agent-device/host-kit/retry';
import { asSnapshotSourceError, snapshotSourceError, SnapshotSourceError } from './errors.ts';
import {
  assertSnapshotBridgeEnvelope,
  bridgeFailureFromEnvelope,
  createSnapshotBridgeDescribeRequest,
  encodeSnapshotBridgeFrame,
  parseSnapshotBridgeEnvelope,
  SnapshotBridgeFrameDecoder,
} from './protocol.ts';
import { snapshotSourceSocketPath } from './host.ts';
import type {
  SnapshotSourceBridgeBinary,
  SnapshotSourceHost,
  SnapshotSourceLimits,
  SnapshotSourceProcess,
  SnapshotSourceSocket,
  SnapshotSourceTarget,
} from './types.ts';
import type { SnapshotBridgeEnvelope } from './protocol.ts';
const CONNECT_RETRY_DELAY_MS = 20,
  CONNECT_ATTEMPT_TIMEOUT_MS = 250;
const SHUTDOWN_TERM_TIMEOUT_MS = 500,
  SHUTDOWN_KILL_TIMEOUT_MS = 500;
type BridgeSession = {
  readonly udid: string;
  readonly generation: string;
  readonly bridgePath: string;
  readonly socketPath: string;
  readonly process: SnapshotSourceProcess;
  socket?: SnapshotSourceSocket;
};
type SnapshotBridgeRequest = Readonly<{
  target: SnapshotSourceTarget;
  bridge: SnapshotSourceBridgeBinary;
  limits: SnapshotSourceLimits;
  maxDepth: number;
  signal?: AbortSignal;
}>;
export class SnapshotBridgeManager {
  private readonly sessions = new Map<string, BridgeSession>();
  private closed = false;
  private readonly host: SnapshotSourceHost;
  constructor(host: SnapshotSourceHost) {
    this.host = host;
  }
  async request(input: SnapshotBridgeRequest): Promise<SnapshotBridgeEnvelope> {
    if (this.closed) throw snapshotSourceError('unsupported', 'source-closed');
    return await this.host.withKeyedLock(`simulator:${input.target.udid}`, async () => {
      const session = await this.ensureSession(input, input.signal);
      try {
        return await this.exchange(
          session,
          input.target,
          input.maxDepth,
          input.limits,
          input.signal,
        );
      } catch (error) {
        const normalized = asSnapshotSourceError(error);
        if (normalized.failureKind === 'process-crash') {
          await this.removeSession(session, false);
        } else if (normalized.failureKind === 'transport-failure') {
          session.socket?.destroy();
          session.socket = undefined;
        }
        throw normalized;
      }
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(async (session) => await this.dispose(session, true)));
  }
  private async ensureSession(
    input: SnapshotBridgeRequest,
    signal: AbortSignal | undefined,
  ): Promise<BridgeSession> {
    const key = input.target.udid;
    const existing = this.sessions.get(key);
    if (
      existing &&
      existing.generation === input.target.generation &&
      existing.bridgePath === input.bridge.path &&
      existing.process.isAlive()
    ) {
      if (!existing.socket || existing.socket.destroyed) {
        existing.socket = await this.connectUntilReady(existing, input.limits, signal);
      }
      return existing;
    }
    if (existing) await this.removeSession(existing, true);

    const socketPath = snapshotSourceSocketPath(this.host, input.target.udid);
    await this.host.ensureDirectory(path.dirname(socketPath));
    await this.host.remove(socketPath);
    const { target, bridge } = input;
    const bridgeProcess = this.host.start(target.udid, bridge.path, socketPath, { signal });
    const session: BridgeSession = {
      udid: input.target.udid,
      generation: input.target.generation,
      bridgePath: input.bridge.path,
      socketPath,
      process: bridgeProcess,
    };
    this.sessions.set(key, session);
    try {
      session.socket = await this.connectUntilReady(session, input.limits, signal);
      return session;
    } catch (error) {
      await this.removeSession(session, true);
      throw asSnapshotSourceError(error);
    }
  }

  private async connectUntilReady(
    session: BridgeSession,
    limits: SnapshotSourceLimits,
    signal: AbortSignal | undefined,
  ): Promise<SnapshotSourceSocket> {
    const deadline = Date.now() + limits.maxDurationMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw snapshotSourceError('cancelled', 'abort-signal');
      if (!session.process.isAlive()) throw bridgeProcessExited(session.process);
      const remainingMs = deadline - Date.now();
      try {
        return await this.host.connect(session.socketPath, {
          signal,
          timeoutMs: Math.min(CONNECT_ATTEMPT_TIMEOUT_MS, remainingMs),
        });
      } catch (error) {
        lastError = error;
        if (error instanceof SnapshotSourceError && error.failureKind === 'cancelled')
          throw asSnapshotSourceError(error);
        await sleep(Math.min(CONNECT_RETRY_DELAY_MS, Math.max(1, remainingMs)));
      }
    }
    throw snapshotSourceError('timeout', 'bridge-connect-deadline', {
      udid: session.udid,
      ...(lastError instanceof Error ? { lastError: lastError.message } : {}),
    });
  }

  private async exchange(
    session: BridgeSession,
    target: SnapshotSourceTarget,
    maxDepth: number,
    limits: SnapshotSourceLimits,
    signal: AbortSignal | undefined,
  ): Promise<SnapshotBridgeEnvelope> {
    if (!session.socket || session.socket.destroyed) {
      session.socket = await this.connectUntilReady(session, limits, signal);
    }
    const socket = session.socket;
    const requestId = randomUUID();
    const request = createSnapshotBridgeDescribeRequest({
      requestId,
      pid: target.pid,
      maxDepth: Math.min(limits.maxTraversalDepth, maxDepth),
      maxNodes: limits.maxNodes,
    });
    const frame = encodeSnapshotBridgeFrame(request, limits);
    return await this.roundTrip(session, socket, frame, requestId, limits, signal, target.pid);
  }

  private async roundTrip(
    session: BridgeSession,
    socket: SnapshotSourceSocket,
    frame: Buffer,
    requestId: string,
    limits: SnapshotSourceLimits,
    signal: AbortSignal | undefined,
    expectedPid: number,
  ): Promise<SnapshotBridgeEnvelope> {
    const decoder = new SnapshotBridgeFrameDecoder(limits.maxResponseBytes - 4);
    return await new Promise<SnapshotBridgeEnvelope>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        socket.destroy();
        finishReject(snapshotSourceError('timeout', 'bridge-request-deadline'));
      }, limits.maxDurationMs);
      const onAbort = () => {
        socket.destroy();
        finishReject(snapshotSourceError('cancelled', 'abort-signal'));
      };
      const onData = (chunk: unknown) => {
        try {
          if (!Buffer.isBuffer(chunk))
            throw snapshotSourceError('transport-failure', 'bridge-data-invalid');
          const frames = decoder.push(chunk);
          for (const body of frames) {
            const envelope = parseSnapshotBridgeEnvelope(body);
            assertSnapshotBridgeEnvelope(envelope, requestId);
            if (typeof envelope.pid !== 'number' || envelope.pid !== expectedPid) {
              throw snapshotSourceError('stale-target', 'bridge-pid-mismatch', {
                expectedPid,
                observedPid: envelope.pid,
              });
            }
            if (envelope.ok !== true) bridgeFailureFromEnvelope(envelope);
            if (typeof envelope.truncated !== 'boolean') {
              throw snapshotSourceError('malformed-tree', 'truncated-invalid');
            }
            finishResolve(envelope);
            return;
          }
        } catch (error) {
          socket.destroy();
          finishReject(error);
        }
      };
      const onError = (error: unknown) => finishReject(asSnapshotSourceError(error));
      const onClose = () => {
        if (!settled) {
          finishReject(
            session.process.isAlive()
              ? snapshotSourceError('transport-failure', 'bridge-connection-closed')
              : bridgeProcessExited(session.process),
          );
        }
      };
      session.process.wait.then(
        () => {
          if (!settled) finishReject(bridgeProcessExited(session.process));
        },
        (error: unknown) => {
          if (!settled) finishReject(asSnapshotSourceError(error));
        },
      );
      const finishResolve = (value: SnapshotBridgeEnvelope) => finish(() => resolve(value));
      const finishReject = (error: unknown) => finish(() => reject(error));
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
        action();
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (signal?.aborted) throw snapshotSourceError('cancelled', 'abort-signal');
        socket.write(frame);
      } catch (error) {
        socket.destroy();
        finishReject(asSnapshotSourceError(error));
      }
    });
  }

  private async removeSession(session: BridgeSession, stopProcess: boolean): Promise<void> {
    if (this.sessions.get(session.udid) === session) this.sessions.delete(session.udid);
    await this.dispose(session, stopProcess);
  }

  private async dispose(session: BridgeSession, stopProcess: boolean): Promise<void> {
    session.socket?.destroy();
    session.socket = undefined;
    if (stopProcess && session.process.isAlive()) {
      session.process.signal('SIGTERM');
      await waitForProcess(session.process, SHUTDOWN_TERM_TIMEOUT_MS);
      if (session.process.isAlive()) {
        session.process.signal('SIGKILL');
        await waitForProcess(session.process, SHUTDOWN_KILL_TIMEOUT_MS);
      }
    }
    await this.host.remove(session.socketPath);
  }
}

function bridgeProcessExited(bridgeProcess: SnapshotSourceProcess): SnapshotSourceError {
  return snapshotSourceError('process-crash', 'bridge-exited', {
    pid: bridgeProcess.pid,
    log: bridgeProcess.readLog().slice(-64 * 1024),
  });
}

async function waitForProcess(
  bridgeProcess: SnapshotSourceProcess,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([
    bridgeProcess.wait.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
