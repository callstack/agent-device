import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { asSnapshotSourceError, snapshotSourceError, SnapshotSourceError } from './errors.ts';
import {
  createSnapshotSourceDeadline,
  remainingSnapshotSourceMs,
  waitForSnapshotSourceDelay,
  type SnapshotSourceDeadline,
} from './deadline.ts';
import { snapshotSourceSocketPath } from './host.ts';
import { createSnapshotBridgeDescribeRequest, encodeSnapshotBridgeFrame } from './protocol.ts';
import { roundTripSnapshotBridge } from './transport.ts';
import type {
  SnapshotSourceBridgeBinary,
  SnapshotSourceHost,
  SnapshotSourceLimits,
  SnapshotSourceProcess,
  SnapshotSourceSocket,
  SnapshotSourceTarget,
} from './types.ts';
import type { SnapshotBridgeEnvelope } from './protocol.ts';

const CONNECT_RETRY_DELAY_MS = 20;
const CONNECT_ATTEMPT_TIMEOUT_MS = 250;
const SHUTDOWN_TERM_TIMEOUT_MS = 500;
const SHUTDOWN_KILL_TIMEOUT_MS = 500;

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
  deadline?: SnapshotSourceDeadline;
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
    const deadline =
      input.deadline ?? createSnapshotSourceDeadline(input.limits.maxDurationMs, input.signal);
    return await this.host.withKeyedLock(`simulator:${input.target.udid}`, async () => {
      remainingSnapshotSourceMs(deadline, 'bridge-request-deadline');
      const previousSession = this.sessions.get(input.target.udid);
      const session = await this.ensureSession(input, deadline);
      try {
        return await this.exchange(session, input, deadline);
      } catch (error) {
        const normalized = asSnapshotSourceError(error);
        if (
          (normalized.failureKind === 'cancelled' || normalized.failureKind === 'timeout') &&
          (normalized.details?.dispatched === true || previousSession !== session)
        ) {
          await this.removeSession(session, true);
        } else if (normalized.failureKind === 'process-crash') {
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
    deadline: SnapshotSourceDeadline,
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
        existing.socket = await this.connectUntilReady(existing, deadline);
      }
      return existing;
    }
    if (existing) await this.removeSession(existing, true);

    const socketPath = snapshotSourceSocketPath(this.host, input.target.udid);
    await this.host.ensureDirectory(path.dirname(socketPath));
    await this.host.remove(socketPath);
    const bridgeProcess = this.host.start(input.target.udid, input.bridge.path, socketPath, {
      signal: deadline.signal,
    });
    const session: BridgeSession = {
      udid: input.target.udid,
      generation: input.target.generation,
      bridgePath: input.bridge.path,
      socketPath,
      process: bridgeProcess,
    };
    this.sessions.set(key, session);
    try {
      session.socket = await this.connectUntilReady(session, deadline);
      return session;
    } catch (error) {
      await this.removeSession(session, true);
      throw asSnapshotSourceError(error);
    }
  }

  private async connectUntilReady(
    session: BridgeSession,
    deadline: SnapshotSourceDeadline,
  ): Promise<SnapshotSourceSocket> {
    let lastError: unknown;
    while (true) {
      const remainingMs = remainingSnapshotSourceMs(deadline, 'bridge-connect-deadline');
      if (!session.process.isAlive()) throw bridgeProcessExited(session.process);
      try {
        return await this.host.connect(session.socketPath, {
          signal: deadline.signal,
          timeoutMs: Math.min(CONNECT_ATTEMPT_TIMEOUT_MS, remainingMs),
        });
      } catch (error) {
        lastError = error;
        if (error instanceof SnapshotSourceError && error.failureKind === 'cancelled') {
          throw error;
        }
        const delayMs = Math.min(
          CONNECT_RETRY_DELAY_MS,
          remainingSnapshotSourceMs(deadline, 'bridge-connect-deadline'),
        );
        try {
          await waitForSnapshotSourceDelay(deadline, delayMs, 'bridge-connect-deadline');
        } catch (sleepError) {
          throw asSnapshotSourceError(sleepError);
        }
      }
      if (lastError instanceof SnapshotSourceError && lastError.failureKind === 'timeout') {
        throw lastError;
      }
    }
  }

  private async exchange(
    session: BridgeSession,
    input: SnapshotBridgeRequest,
    deadline: SnapshotSourceDeadline,
  ): Promise<SnapshotBridgeEnvelope> {
    if (!session.socket || session.socket.destroyed) {
      session.socket = await this.connectUntilReady(session, deadline);
    }
    const requestId = randomUUID();
    const request = createSnapshotBridgeDescribeRequest({
      requestId,
      pid: input.target.pid,
      generation: input.target.generation,
      maxDepth: Math.min(input.limits.maxTraversalDepth, input.maxDepth),
      maxNodes: input.limits.maxNodes,
      maxDurationMs: remainingSnapshotSourceMs(deadline, 'bridge-request-deadline'),
      maxResponseBytes: input.limits.maxResponseBytes,
    });
    const frame = encodeSnapshotBridgeFrame(request, input.limits);
    return await roundTripSnapshotBridge({
      process: session.process,
      socket: session.socket,
      frame,
      requestId,
      deadline,
      limits: input.limits,
      expectedPid: input.target.pid,
      expectedGeneration: input.target.generation,
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
