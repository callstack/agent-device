import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SnapshotSourceError } from '@agent-device/capture-kit/snapshot-source-channel';
import { asSnapshotSourceError, snapshotSourceError } from './errors.ts';
import {
  createSnapshotSourceDeadline,
  remainingSnapshotSourceMs,
  waitForSnapshotSourceDelay,
  type SnapshotSourceDeadline,
} from './deadline.ts';
import { createDetachedAttempts } from '../detached-attempt.ts';
import { snapshotSourceSocketPath } from './host.ts';
import { bridgeProcessExited } from './process.ts';
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
  readonly bridgePath: string;
  readonly socketPath: string;
  readonly process: SnapshotSourceProcess;
  socket?: SnapshotSourceSocket;
};

/**
 * Work this manager owns and so has to be able to end: one request's turn on a Simulator, or the
 * session creation running inside that turn. `close()` aborts `interrupt` and then waits for
 * `settled`, which is what makes a closed source hold no bridge rather than promise one: the abort
 * tells the work to stop, and the wait proves it did.
 */
type OwnedWork = Readonly<{
  /** Ends the work: a turn must not start its capture, a creation must not publish its session. */
  readonly interrupt: AbortController;
  readonly settled: Promise<void>;
}>;

/**
 * What the manager holds for one Simulator, and the one place that says who may stop a bridge.
 *
 * `creating` says source-owned work is inside the host making the session, and owns any helper and
 * connection it starts; `live` says a session is published and the manager owns it. A creation
 * publishes only when it succeeds, so one phase names one owner and a creation that a close refuses
 * still stops what it started. A creation clears its own entry, including after a close, because only
 * it knows how far it got.
 */
type BridgeEntry =
  | { phase: 'creating'; work: OwnedWork; session?: BridgeSession; failure?: SnapshotSourceError }
  | Readonly<{
      phase: 'live';
      session: BridgeSession;
    }>;

type SnapshotBridgeRequest = Readonly<{
  target: SnapshotSourceTarget;
  bridge: SnapshotSourceBridgeBinary;
  limits: SnapshotSourceLimits;
  maxDepth: number;
  nativeLevelsHint?: number;
  surfaceHostExecutables?: readonly string[];
  deadline: SnapshotSourceDeadline;
  readinessDeadline?: SnapshotSourceDeadline;
}>;

export class SnapshotBridgeManager {
  private readonly entries = new Map<string, BridgeEntry>();
  private readonly startupFailures = new Map<
    string,
    Readonly<{ generation: string; failure: SnapshotSourceError }>
  >();
  private readonly requestQueues = new Map<string, Promise<void>>();
  /**
   * Every turn and creation underway. The queue names only the newest request for a Simulator, so this
   * is how `close()` reaches a creation, and a capture already in flight behind it, from the moment
   * either registers — before either has touched the host.
   */
  private readonly activeWork = new Set<OwnedWork>();
  private readonly ownerId = randomUUID();
  private closed = false;
  private closing?: Promise<void>;
  private readonly readiness = createDetachedAttempts<BridgeSession>({
    waitMs: 2000,
    waitGrant: 'first-caller',
  });
  private readonly host: SnapshotSourceHost;

  constructor(host: SnapshotSourceHost) {
    this.host = host;
  }

  async request(input: SnapshotBridgeRequest): Promise<SnapshotBridgeEnvelope> {
    if (this.closed) throw closedSourceRefusal();
    return await this.withSimulatorLock(input.target.simulator.udid, input.deadline, (turn) =>
      this.requestInSimulator(input, turn),
    );
  }

  private async requestInSimulator(
    input: SnapshotBridgeRequest,
    turn: OwnedWork,
  ): Promise<SnapshotBridgeEnvelope> {
    if (refusedByClose(this.closed, turn)) throw closedSourceRefusal();
    const deadline = input.deadline;
    remainingSnapshotSourceMs(deadline, 'bridge-request-deadline');
    const udid = input.target.simulator.udid;
    const previousSession = liveSession(this.entries.get(udid));
    const session = await this.ensureSession(udid, input, deadline, turn);
    try {
      const targetStartTime = await this.readTargetStartTime(input.target, deadline);
      const envelope = await this.exchange(session, input, deadline, turn);
      await this.assertTargetStillCurrent(input.target, targetStartTime, deadline);
      return envelope;
    } catch (error) {
      const normalized = await this.handleRequestFailure(error, session, previousSession);
      throw normalized;
    }
  }

  private async handleRequestFailure(
    error: unknown,
    session: BridgeSession,
    previousSession: BridgeSession | undefined,
  ): Promise<SnapshotSourceError> {
    const normalized = asSnapshotSourceError(error);
    if (shouldDiscardSession(normalized, session, previousSession)) {
      await this.removeSession(session, true);
    } else if (normalized.failureKind === 'process-crash') {
      await this.removeSession(session, false);
    } else if (normalized.failureKind === 'transport-failure') {
      session.socket?.destroy();
      session.socket = undefined;
    }
    return normalized;
  }

  private async withSimulatorLock<T>(
    udid: string,
    deadline: SnapshotSourceDeadline,
    action: (turn: OwnedWork) => Promise<T>,
  ): Promise<T> {
    const previous = this.requestQueues.get(udid) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turnFinished = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const turn: OwnedWork = { interrupt: new AbortController(), settled: turnFinished };
    // Registered before the first await, so it happens in the same synchronous step as the `closed`
    // check in `request()`: a turn can never join the active set after `close()` has read it.
    this.activeWork.add(turn);
    const current = previous.then(() => turnFinished);
    this.requestQueues.set(udid, current);
    try {
      await waitForSimulatorTurn(previous, deadline, turn.interrupt.signal);
      if (refusedByClose(this.closed, turn)) throw closedSourceRefusal();
      return await action(turn);
    } finally {
      releaseTurn();
      this.activeWork.delete(turn);
      if (this.requestQueues.get(udid) === current) this.requestQueues.delete(udid);
    }
  }

  /**
   * Ends every bridge this manager owns: the sessions it published, the creations still inside the
   * host, and the requests queued behind them.
   *
   * The `closed` checks a request makes cannot see a close that lands while it is inside the host, so
   * close adopts the underway work: it ends each one and waits for it to stop the helper and the
   * connection it did start. Otherwise a creation resuming after the published sessions were collected
   * would start a helper nobody has since published, and no later close would know to stop it — the
   * process and its socket would outlive the source.
   *
   * A queued request is refused rather than left waiting for the turn of a capture whose bridge is
   * being stopped. A capture already dispatched to the bridge is not rescued: its bridge stops with
   * the rest, and close waits for that capture to settle before it returns.
   */
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.readiness.close();
    this.startupFailures.clear();
    const adopted = [...this.activeWork];
    this.requestQueues.clear();
    for (const work of adopted) work.interrupt.abort();
    const sessions: BridgeSession[] = [];
    for (const [udid, entry] of this.entries) {
      if (entry.phase !== 'live') continue;
      this.entries.delete(udid);
      sessions.push(entry.session);
    }
    this.closing = Promise.all([
      ...sessions.map((session) => this.dispose(session, true)),
      ...adopted.map(async (work) => {
        await work.settled;
      }),
    ]).then(() => {});
    return this.closing;
  }

  private async ensureSession(
    udid: string,
    input: SnapshotBridgeRequest,
    deadline: SnapshotSourceDeadline,
    turn: OwnedWork,
  ): Promise<BridgeSession> {
    const existing = liveSession(this.entries.get(udid));
    if (existing) {
      if (existing.bridgePath === input.bridge.path && existing.process.isAlive()) {
        if (!existing.socket || existing.socket.destroyed) {
          await this.connectUntilReady(existing, deadline, turn.interrupt.signal);
        }
        return existing;
      }
      await this.removeSession(existing, true);
    }

    if (refusedByClose(this.closed, turn)) throw closedSourceRefusal();
    const startupFailure = this.startupFailures.get(udid);
    this.startupFailures.delete(udid);
    if (startupFailure?.generation === input.target.generation) throw startupFailure.failure;
    const waitDeadline =
      input.readinessDeadline ??
      createSnapshotSourceDeadline(
        Math.min(2000, remainingSnapshotSourceMs(deadline, 'bridge-readiness-deadline')),
        deadline.signal,
      );
    return await this.readiness
      .value(`${udid}:${input.bridge.path}`, {
        start: (signal) =>
          this.createSession(udid, input, signal).catch((error: unknown) => {
            const failure = asSnapshotSourceError(error);
            if (!this.closed) {
              this.startupFailures.set(udid, { generation: input.target.generation, failure });
            }
            throw failure;
          }),
        wait: async (ms, stop) => {
          const creation = this.entries.get(udid);
          const left = Math.max(0, waitDeadline.clock.remainingMs(waitDeadline.now()));
          await waitForSnapshotSourceDelay(
            deadline,
            Math.min(ms, left),
            'bridge-readiness-deadline',
            AbortSignal.any([stop, turn.interrupt.signal]),
          );
          if (refusedByClose(this.closed, turn)) {
            if (creation?.phase === 'creating') {
              await creation.work.settled;
              if (creation.failure?.failureKind === 'process-crash') throw creation.failure;
            }
            throw closedSourceRefusal();
          }
        },
        pending: () => {
          const creation = this.entries.get(udid);
          if (
            deadline.clock.remainingMs(deadline.now()) <= 0 &&
            creation?.phase === 'creating' &&
            creation.session &&
            !creation.session.process.isAlive()
          ) {
            return snapshotSourceError('timeout', 'bridge-exit-deadline');
          }
          return snapshotSourceError('preparing', 'bridge-readiness-pending');
        },
      })
      .catch((error: unknown) => {
        if (this.startupFailures.get(udid)?.failure === error) this.startupFailures.delete(udid);
        throw error;
      });
  }

  private async createSession(
    udid: string,
    input: SnapshotBridgeRequest,
    signal: AbortSignal,
  ): Promise<BridgeSession> {
    const socketPath = snapshotSourceSocketPath(this.host, udid, this.ownerId);
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const creation: OwnedWork = { interrupt: new AbortController(), settled };
    const expiry = new AbortController();
    const timer = setTimeout(() => expiry.abort(), 10000);
    const deadline = createSnapshotSourceDeadline(
      10000,
      AbortSignal.any([signal, expiry.signal, creation.interrupt.signal]),
    );
    const assertOpen = () => {
      if (refusedByClose(this.closed, creation)) throw closedSourceRefusal();
      remainingSnapshotSourceMs(deadline, 'bridge-startup-deadline');
    };
    const entry: Extract<BridgeEntry, { phase: 'creating' }> = {
      phase: 'creating',
      work: creation,
    };
    // Registered before the first await, in the same synchronous step as the refusal check below: from
    // here the creation is the only owner of this Simulator's bridge, and of whatever it starts.
    this.entries.set(udid, entry);
    this.activeWork.add(creation);
    try {
      assertOpen();
      await this.host.ensureDirectory(path.dirname(socketPath));
      assertOpen();
      await this.host.remove(socketPath);
      // The host held this call, so a close that landed inside it is the manager's own refusal rather
      // than a host failure: the creation started nothing, so it has nothing to stop.
      assertOpen();
      const session: BridgeSession = {
        udid,
        bridgePath: input.bridge.path,
        socketPath,
        process: this.host.start(input.target.simulator, input.bridge.path, socketPath, {
          signal: deadline.signal,
        }),
      };
      entry.session = session;
      try {
        await this.connectUntilReady(session, deadline, creation.interrupt.signal);
        assertOpen();
        this.entries.set(udid, { phase: 'live', session });
        return session;
      } catch (error) {
        const failure = expiry.signal.aborted
          ? snapshotSourceError('timeout', 'bridge-startup-deadline')
          : asSnapshotSourceError(error);
        await this.removeSession(session, true);
        if (failure.failureKind !== 'process-crash' && refusedByClose(this.closed, creation)) {
          throw closedSourceRefusal();
        }
        throw failure;
      }
    } catch (error) {
      entry.failure = asSnapshotSourceError(error);
      if (entry.failure.failureKind === 'process-crash') throw entry.failure;
      if (refusedByClose(this.closed, creation)) throw closedSourceRefusal();
      if (expiry.signal.aborted) throw snapshotSourceError('timeout', 'bridge-startup-deadline');
      throw entry.failure;
    } finally {
      clearTimeout(timer);
      resolveSettled();
      this.activeWork.delete(creation);
      if (this.entries.get(udid) === entry) this.entries.delete(udid);
    }
  }

  private async connectUntilReady(
    session: BridgeSession,
    deadline: SnapshotSourceDeadline,
    stop: AbortSignal,
  ): Promise<SnapshotSourceSocket> {
    while (true) {
      if (stop.aborted) throw closedSourceRefusal();
      const remainingMs = remainingSnapshotSourceMs(deadline, 'bridge-connect-deadline');
      if (!session.process.isAlive()) {
        throw await this.bridgeExitOrClose(session, deadline, stop);
      }
      let socket: SnapshotSourceSocket;
      try {
        socket = await this.host.connect(session.socketPath, {
          signal: deadline.signal,
          timeoutMs: Math.min(CONNECT_ATTEMPT_TIMEOUT_MS, remainingMs),
        });
      } catch (error) {
        await this.awaitConnectRetry(deadline, stop, error);
        continue;
      }
      // A connect stops early only because a close owns this work, and a close ends a session it
      // published. A refused caller would never hand this connection to anyone, so it ends here.
      if (stop.aborted || deadline.signal?.aborted) {
        socket.destroy();
        if (stop.aborted) throw closedSourceRefusal();
        throw snapshotSourceError('cancelled', 'abort-signal');
      }
      const invalidate = () => {
        if (session.socket === socket) session.socket = undefined;
      };
      const onError = () => {
        invalidate();
        socket.destroy();
      };
      const onClose = () => {
        invalidate();
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      socket.on('error', onError);
      socket.on('close', onClose);
      session.socket = socket;
      return socket;
    }
  }

  /**
   * Why the helper is gone, unless the close or the request's own budget ends that question first.
   *
   * The exit status is not free to wait for: the host settles it when the child's own pipes close, and a
   * descendant that inherited one can hold it pending indefinitely. Neither a close nor a spent budget can
   * make that answer arrive, so each answers here and the refused work goes on to stop what it started.
   * Whoever stops waiting leaves the read behind as an observer, so a status that answers late is still
   * diagnosed.
   *
   * The close and the budget win only while the status is still pending, so the race subscribes to the raw
   * status and not to its typed conversion: converting takes a turn of its own, and an answer landing in
   * that turn must not be overwritten.
   */
  private async bridgeExitOrClose(
    session: BridgeSession,
    deadline: SnapshotSourceDeadline,
    stop: AbortSignal,
  ): Promise<SnapshotSourceError> {
    // Read the budget before anything is subscribed: a deadline that is already spent ends the question
    // here, with no listener and no timer to take back.
    const remainingMs = remainingSnapshotSourceMs(deadline, 'bridge-exit-deadline');
    const exited = bridgeProcessExited(this.host, session.process);
    const stopWaiting = new AbortController();
    try {
      const answer = await Promise.race([
        session.process.wait,
        waitForSnapshotSourceDelay(
          deadline,
          remainingMs,
          'bridge-exit-deadline',
          AbortSignal.any([stop, stopWaiting.signal]),
        ),
      ]).catch((error: unknown) => {
        if (error instanceof SnapshotSourceError) throw error;
        return 'status' as const;
      });
      if (answer !== undefined) return await exited;
      if (stop.aborted) throw closedSourceRefusal();
      throw snapshotSourceError('timeout', 'bridge-exit-deadline');
    } finally {
      stopWaiting.abort();
    }
  }

  /**
   * Waits out the retry after a connect the bridge did not answer. Throws the failure that ends the
   * wait instead: the close that owns this work, the caller's cancellation, or the attempt's own
   * timeout. The close is checked before the timeout, so a close that ended the wait is never reported
   * as the connect timeout that happened to come with it.
   */
  private async awaitConnectRetry(
    deadline: SnapshotSourceDeadline,
    stop: AbortSignal,
    error: unknown,
  ): Promise<void> {
    if (stop.aborted) throw closedSourceRefusal();
    const refused = error instanceof SnapshotSourceError ? error : undefined;
    if (refused?.failureKind === 'cancelled') throw refused;
    const delayMs = Math.min(
      CONNECT_RETRY_DELAY_MS,
      remainingSnapshotSourceMs(deadline, 'bridge-connect-deadline'),
    );
    try {
      await waitForSnapshotSourceDelay(deadline, delayMs, 'bridge-connect-deadline', stop);
    } catch (sleepError) {
      throw asSnapshotSourceError(sleepError);
    }
    if (stop.aborted) throw closedSourceRefusal();
    if (refused?.failureKind === 'timeout') throw refused;
  }

  private async exchange(
    session: BridgeSession,
    input: SnapshotBridgeRequest,
    deadline: SnapshotSourceDeadline,
    turn: OwnedWork,
  ): Promise<SnapshotBridgeEnvelope> {
    if (!session.socket || session.socket.destroyed) {
      await this.connectUntilReady(session, deadline, turn.interrupt.signal);
    }
    const socket = session.socket;
    if (!socket || socket.destroyed)
      throw snapshotSourceError('transport-failure', 'bridge-connection-closed');
    // Nothing is sent once a close owns this turn: the bridge it would reach is being stopped.
    if (refusedByClose(this.closed, turn)) throw closedSourceRefusal();
    const requestId = randomUUID();
    const request = createSnapshotBridgeDescribeRequest({
      requestId,
      pid: input.target.pid,
      generation: input.target.generation,
      maxDepth: Math.min(input.limits.maxTraversalDepth, input.maxDepth),
      maxNodes: input.limits.maxNodes,
      maxDurationMs: remainingSnapshotSourceMs(deadline, 'bridge-request-deadline'),
      maxResponseBytes: input.limits.maxResponseBytes,
      ...(input.nativeLevelsHint !== undefined ? { nativeLevelsHint: input.nativeLevelsHint } : {}),
      ...(input.surfaceHostExecutables
        ? {
            surfaceHosts: {
              simulatorUdid: input.target.simulator.udid,
              executables: input.surfaceHostExecutables,
            },
          }
        : {}),
    });
    const frame = encodeSnapshotBridgeFrame(request, input.limits);
    return await roundTripSnapshotBridge({
      process: session.process,
      socket,
      frame,
      requestId,
      deadline,
      limits: input.limits,
      expectedPid: input.target.pid,
      expectedGeneration: input.target.generation,
      host: this.host,
    });
  }

  private async readTargetStartTime(
    target: SnapshotSourceTarget,
    deadline: SnapshotSourceDeadline,
  ): Promise<string> {
    const startTime = await this.host.readTargetProcessStartTime(target.pid, {
      signal: deadline.signal,
      timeoutMs: remainingSnapshotSourceMs(deadline, 'target-identity-deadline'),
    });
    if (!startTime) {
      throw snapshotSourceError('stale-target', 'target-process-unavailable', {
        pid: target.pid,
        generation: target.generation,
      });
    }
    if (target.processStartTime !== undefined && target.processStartTime !== startTime) {
      throw snapshotSourceError('stale-target', 'target-process-changed', {
        pid: target.pid,
        generation: target.generation,
        expectedStartTime: target.processStartTime,
        observedStartTime: startTime,
      });
    }
    return startTime;
  }

  private async assertTargetStillCurrent(
    target: SnapshotSourceTarget,
    expectedStartTime: string,
    deadline: SnapshotSourceDeadline,
  ): Promise<void> {
    const observedStartTime = await this.host.readTargetProcessStartTime(target.pid, {
      signal: deadline.signal,
      timeoutMs: remainingSnapshotSourceMs(deadline, 'target-identity-deadline'),
    });
    if (observedStartTime !== expectedStartTime) {
      throw snapshotSourceError('stale-target', 'target-process-changed', {
        pid: target.pid,
        generation: target.generation,
        expectedStartTime,
        observedStartTime,
      });
    }
  }

  private async removeSession(session: BridgeSession, stopProcess: boolean): Promise<void> {
    const entry = this.entries.get(session.udid);
    if (entry?.phase === 'live' && entry.session === session) this.entries.delete(session.udid);
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

function liveSession(entry: BridgeEntry | undefined): BridgeSession | undefined {
  return entry?.phase === 'live' ? entry.session : undefined;
}

/** Whether a close owns this source while `work` was underway, so `work` must not go on. */
function refusedByClose(closed: boolean, work: OwnedWork): boolean {
  return closed || work.interrupt.signal.aborted;
}

/**
 * The refusal for work a closed manager could not serve. It keeps the typed reason a closed source
 * already answers with: the manager ended, which says nothing about the app generation the capture
 * was reading.
 */
function closedSourceRefusal(): SnapshotSourceError {
  return snapshotSourceError('unsupported', 'source-closed');
}

async function waitForSimulatorTurn(
  previous: Promise<void>,
  deadline: SnapshotSourceDeadline,
  stop: AbortSignal,
): Promise<void> {
  const timeoutMs = remainingSnapshotSourceMs(deadline, 'bridge-request-deadline');
  await Promise.race([
    previous,
    waitForSnapshotSourceDelay(deadline, timeoutMs, 'bridge-request-deadline', stop).then(() => {
      // Only a spent budget is a timeout. A wait that ended because a close owns this turn is
      // refused by the caller, which reports the close instead.
      if (!stop.aborted) throw snapshotSourceError('timeout', 'bridge-request-deadline');
    }),
  ]);
}

function shouldDiscardSession(
  error: SnapshotSourceError,
  session: BridgeSession,
  previousSession: BridgeSession | undefined,
): boolean {
  return (
    (error.failureKind === 'cancelled' || error.failureKind === 'timeout') &&
    (error.details?.bridgeRequestSent === true || previousSession !== session)
  );
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
