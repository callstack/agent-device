import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'vitest';
import type { ExecResult } from '@agent-device/host-kit/command';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';
import { createSnapshotSourceDeadline } from './deadline.ts';
import { SnapshotSourceError } from './errors.ts';
import { createSnapshotSourceHost } from './host.ts';
import {
  encodeSnapshotBridgeFrame,
  SNAPSHOT_SOURCE_PROTOCOL_VERSION,
  SNAPSHOT_SOURCE_VERSION,
  type SnapshotBridgeEnvelope,
} from './protocol.ts';
import { roundTripSnapshotBridge } from './transport.ts';
import type {
  SnapshotSourceHost,
  SnapshotSourceLimits,
  SnapshotSourceProcess,
  SnapshotSourceSocket,
} from './types.ts';

const limits: SnapshotSourceLimits = {
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 4 * 1024,
  maxNodes: 20,
  maxTraversalDepth: 10,
  maxDurationMs: 1000,
};

const TARGET_PID = 123;
const GENERATION = 'generation-1';

test('a bridge process carries one exit reaction however many round trips it serves', async () => {
  const fixture = createTransportFixture();

  await completeRoundTrip(fixture);
  const afterFirst = fixture.process.wait.reactions;
  for (let trip = 0; trip < 20; trip += 1) await completeRoundTrip(fixture);

  assert.ok(
    afterFirst <= 1,
    `the first round trip left ${afterFirst} reactions on the exit status`,
  );
  assert.equal(
    fixture.process.wait.reactions,
    afterFirst,
    'later round trips added reactions to the exit status',
  );
});

test('a bridge exit during a later round trip rejects it as a process crash', async () => {
  const fixture = createTransportFixture();
  await completeRoundTrip(fixture);
  await completeRoundTrip(fixture);
  const inFlight = startRoundTrip(fixture);

  fixture.process.exit(137);

  const failure = await rejection(inFlight.settled);
  assert.ok(failure instanceof SnapshotSourceError);
  assert.equal(failure.failureKind, 'process-crash');
  assert.equal(failure.failureCode, 'bridge-exited');
  assert.equal(failure.details?.pid, fixture.process.pid);
  assert.equal(failure.details?.exitCode, 137);
  assert.equal(exitDiagnostics(fixture).length, 1);
  assert.equal(exitDiagnostics(fixture)[0]?.data?.stderr, 'fixture log');
});

test('an exit status that cannot be read rejects the round trip in flight with the host error', async () => {
  const fixture = createTransportFixture();
  await completeRoundTrip(fixture);
  const inFlight = startRoundTrip(fixture);

  fixture.process.failStatusRead(new Error('status pipe closed'));

  const failure = await rejection(inFlight.settled);
  assert.ok(failure instanceof SnapshotSourceError);
  assert.equal(failure.failureKind, 'transport-failure');
  assert.equal(failure.failureCode, 'unexpected-host-error');
  assert.equal(failure.details?.error, 'status pipe closed');
  assert.deepEqual(exitDiagnostics(fixture), []);
});

test('a round trip that starts after the bridge exited rejects as a process crash', async () => {
  const fixture = createTransportFixture();
  await completeRoundTrip(fixture);
  fixture.process.exit(1);
  // The exit is seen while no round trip is waiting, so the next one finds the status already settled.
  await nextTurn();

  const late = startRoundTrip(fixture, 200);

  const failure = await rejection(late.settled);
  assert.ok(failure instanceof SnapshotSourceError);
  assert.equal(failure.failureKind, 'process-crash');
  assert.equal(failure.failureCode, 'bridge-exited');
  assert.equal(failure.details?.exitCode, 1);
});

test('a round trip that settled is not told about a later bridge exit', async () => {
  const fixture = createTransportFixture();
  await completeRoundTrip(fixture);

  fixture.process.exit(1);
  await nextTurn();

  assert.deepEqual(exitDiagnostics(fixture), []);
});

type TransportFixture = {
  host: SnapshotSourceHost;
  process: FakeBridgeProcess;
  socket: FakeBridgeSocket;
  diagnostics: Array<Parameters<SnapshotSourceHost['emitDiagnostic']>[0]>;
  requests: number;
};

function createTransportFixture(): TransportFixture {
  const diagnostics: TransportFixture['diagnostics'] = [];
  const host: SnapshotSourceHost = {
    ...createSnapshotSourceHost(createLiveTestHostEnvironment()),
    emitDiagnostic: (event) => diagnostics.push(event),
  };
  return {
    host,
    process: new FakeBridgeProcess(),
    socket: new FakeBridgeSocket(),
    diagnostics,
    requests: 0,
  };
}

/** Writes one request to the fixture's bridge and leaves it unanswered. */
function startRoundTrip(
  fixture: TransportFixture,
  timeoutMs = limits.maxDurationMs,
): Readonly<{ requestId: string; settled: Promise<SnapshotBridgeEnvelope> }> {
  fixture.requests += 1;
  const requestId = `request-${fixture.requests}`;
  const settled = roundTripSnapshotBridge({
    process: fixture.process,
    socket: fixture.socket,
    frame: Buffer.from(requestId),
    requestId,
    deadline: createSnapshotSourceDeadline(timeoutMs, undefined),
    limits,
    expectedPid: TARGET_PID,
    expectedGeneration: GENERATION,
    host: fixture.host,
  });
  return { requestId, settled };
}

async function completeRoundTrip(fixture: TransportFixture): Promise<SnapshotBridgeEnvelope> {
  const { requestId, settled } = startRoundTrip(fixture);
  fixture.socket.answer(requestId);
  return await settled;
}

async function rejection(pending: Promise<unknown>): Promise<unknown> {
  return await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** Lets every promise reaction already queued run, so a test can name what stayed silent. */
async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function exitDiagnostics(fixture: TransportFixture): TransportFixture['diagnostics'] {
  return fixture.diagnostics.filter(
    (event) => event.phase === 'ios.snapshot-source.bridge-process-exit',
  );
}

/**
 * A promise that counts every reaction registered on it, however it was registered: `then`, `catch`,
 * `await`, and `Promise.race` all reach `then` on a subclass instance.
 */
class ReactionCountingPromise<T> extends Promise<T> {
  reactions = 0;

  override then<TResult1 = T, TResult2 = never>(
    onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.reactions += 1;
    return super.then(onFulfilled, onRejected);
  }
}

class FakeBridgeProcess implements SnapshotSourceProcess {
  readonly pid = 900;
  readonly wait: ReactionCountingPromise<ExecResult>;
  private alive = true;
  private resolveStatus!: (result: ExecResult) => void;
  private rejectStatus!: (error: Error) => void;

  constructor() {
    this.wait = new ReactionCountingPromise((resolve, reject) => {
      this.resolveStatus = resolve;
      this.rejectStatus = reject;
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  signal(): void {
    throw new Error('a round trip never signals the bridge process');
  }

  readLog(): string {
    return 'fixture log';
  }

  exit(exitCode: number): void {
    this.alive = false;
    this.resolveStatus({ stdout: '', stderr: '', exitCode });
  }

  failStatusRead(error: Error): void {
    this.alive = false;
    this.rejectStatus(error);
  }
}

class FakeBridgeSocket extends EventEmitter implements SnapshotSourceSocket {
  destroyed = false;

  write(): boolean {
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }

  /** Delivers the bridge's reply to `requestId`, the way the guest answers a describe request. */
  answer(requestId: string): void {
    this.emit(
      'data',
      encodeSnapshotBridgeFrame(
        {
          protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
          sourceVersion: SNAPSHOT_SOURCE_VERSION,
          requestId,
          ok: true,
          pid: TARGET_PID,
          generation: GENERATION,
          truncated: false,
        },
        limits,
      ),
    );
  }
}
