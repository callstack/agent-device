import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'vitest';
import { createSnapshotSourceHost } from './host.ts';
import { SnapshotSourceError, snapshotSourceError } from './errors.ts';
import { createSnapshotSourceDeadline } from './deadline.ts';
import {
  encodeSnapshotBridgeFrame,
  SNAPSHOT_SOURCE_PROTOCOL_VERSION,
  SNAPSHOT_SOURCE_VERSION,
} from './protocol.ts';
import { SnapshotBridgeManager } from './lifecycle.ts';
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
  maxDurationMs: 100,
};

const target = {
  udid: 'simulator-1',
  runtime: 'iOS 26.2',
  pid: 123,
  generation: 'generation-1',
};

const bridge = {
  path: '/tmp/snapshot-bridge',
  sourceHash: 'source-hash',
  cacheKey: 'cache-key',
  protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
  sourceVersion: SNAPSHOT_SOURCE_VERSION,
};

test('the bridge manager reuses a healthy per-device helper and stops it exactly once', async () => {
  const fixture = createLifecycleFixture();
  const manager = new SnapshotBridgeManager(fixture.host);

  await manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  await manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });

  assert.equal(fixture.processes.length, 1);
  assert.equal(fixture.sockets.length, 1);
  await manager.close();
  assert.deepEqual(fixture.processes[0]!.signals, ['SIGTERM']);
});

test('a new target generation reuses the healthy helper and carries generation per request', async () => {
  const fixture = createLifecycleFixture();
  const manager = new SnapshotBridgeManager(fixture.host);

  await manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  await manager.request({
    target: { ...target, generation: 'generation-2' },
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(),
  });

  assert.equal(fixture.processes.length, 1);
  assert.deepEqual(fixture.processes[0]!.signals, []);
  await manager.close();
  assert.deepEqual(fixture.processes[0]!.signals, ['SIGTERM']);
});

test('cancellation while queued prevents a later dispatch', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 200 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const first = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(undefined, 1000),
  });
  await waitForDispatch(fixture);

  const controller = new AbortController();
  const startedAt = Date.now();
  const queued = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(controller.signal, 1000),
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    queued,
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'cancelled',
  );
  assert.ok(Date.now() - startedAt < 100);
  assert.equal(fixture.sockets[0]?.writes, 1);
  await first;
  assert.equal(fixture.sockets.length, 1);
  await manager.close();
});

test('cancelling a middle waiter does not release the following request early', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 120 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const first = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(undefined, 1000),
  });
  await waitForDispatch(fixture);

  const controller = new AbortController();
  const middle = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(controller.signal, 1000),
  });
  const last = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(undefined, 1000),
  });
  controller.abort();

  await assert.rejects(
    middle,
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'cancelled',
  );
  assert.equal(fixture.sockets[0]?.writes, 1);
  await first;
  await last;
  assert.equal(fixture.sockets[0]?.writes, 2);
  await manager.close();
});

test('independent managers own distinct sockets for the same Simulator', async () => {
  const fixture = createLifecycleFixture();
  const first = new SnapshotBridgeManager(fixture.host);
  const second = new SnapshotBridgeManager(fixture.host);

  await first.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  await second.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });

  assert.equal(fixture.socketPaths.length, 2);
  assert.notEqual(fixture.socketPaths[0], fixture.socketPaths[1]);
  await first.close();
  assert.equal(fixture.processes[1]?.isAlive(), true);
  await second.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  await second.close();
});

test('request cancellation after dispatch reaps the exact helper before recovery', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 80 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const controller = new AbortController();
  const request = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(controller.signal),
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    request,
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'cancelled',
  );
  assert.deepEqual(fixture.processes[0]?.signals, ['SIGTERM']);
  assert.equal(fixture.processes[0]?.alive, false);
  await manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  assert.equal(fixture.processes.length, 2);
  await manager.close();
  assert.deepEqual(fixture.processes[1]?.signals, ['SIGTERM']);
});

test('pre-dispatch cancellation preserves a healthy helper', async () => {
  const fixture = createLifecycleFixture({ connectDelayMs: 40 });
  const manager = new SnapshotBridgeManager(fixture.host);
  await manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 500 },
    maxDepth: 10,
    deadline: deadline(undefined, 500),
  });
  fixture.sockets[0]!.destroy();

  const controller = new AbortController();
  const request = manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 500 },
    maxDepth: 10,
    deadline: deadline(controller.signal, 500),
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    request,
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'cancelled',
  );
  assert.equal(fixture.processes.length, 1);
  assert.deepEqual(fixture.processes[0]?.signals, []);
  assert.equal(fixture.processes[0]?.alive, true);

  await manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 500 },
    maxDepth: 10,
    deadline: deadline(undefined, 500),
  });
  assert.equal(fixture.processes.length, 1);
  await manager.close();
  assert.deepEqual(fixture.processes[0]?.signals, ['SIGTERM']);
});

test('one absolute deadline covers helper connect and response read', async () => {
  const fixture = createLifecycleFixture({ connectDelayMs: 70, responseDelayMs: 70 });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({
      target,
      bridge,
      limits: { ...limits, maxDurationMs: 100 },
      maxDepth: 10,
      deadline: deadline(undefined, 100),
    }),
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'timeout',
  );
  assert.deepEqual(fixture.processes[0]?.signals, ['SIGTERM']);
  await manager.close();
});

test('a crashed helper is removed and the next request starts a fresh helper', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 80 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  setTimeout(() => fixture.processes[0]?.crash(), 10);

  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof SnapshotSourceError && error.failureKind === 'process-crash',
  );
  assert.equal(fixture.processes[0]?.signals.length, 0);

  await manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  assert.equal(fixture.processes.length, 2);
  await manager.close();
});

test('a crashed helper emits its bounded log once and keeps exit facts typed', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 80 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  setTimeout(() => fixture.processes[0]?.crash(), 10);
  let failure: SnapshotSourceError | undefined;

  await assert.rejects(request, (error: unknown) => {
    failure = error instanceof SnapshotSourceError ? error : undefined;
    return failure?.failureKind === 'process-crash';
  });
  assert.equal(failure?.details?.pid, 700);
  assert.equal(failure?.details?.exitCode, 1);
  assert.equal(failure?.details?.log, undefined);
  const processDiagnostics = fixture.diagnostics.filter(
    (event) => event.phase === 'ios.snapshot-source.bridge-process-exit',
  );
  assert.equal(processDiagnostics.length, 1);
  assert.equal(processDiagnostics[0]?.data?.pid, 700);
  assert.equal(processDiagnostics[0]?.data?.stderr, 'fixture log');
  await manager.close();
});

test('the manager rejects a response for a different target process as stale', async () => {
  const fixture = createLifecycleFixture({ responsePid: target.pid + 1 });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() }),
    (error: unknown) =>
      error instanceof SnapshotSourceError && error.failureKind === 'stale-target',
  );
  await manager.close();
});

test('the manager rejects a response carrying a previous target generation as stale', async () => {
  const fixture = createLifecycleFixture({ responseGeneration: 'generation-0' });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() }),
    (error: unknown) =>
      error instanceof SnapshotSourceError &&
      error.failureKind === 'stale-target' &&
      error.failureCode === 'bridge-generation-mismatch',
  );
  await manager.close();
});

test('the manager rejects a tree when the target process changes during acquisition', async () => {
  const fixture = createLifecycleFixture({ targetStartTimes: ['start-1', 'start-2'] });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() }),
    (error: unknown) =>
      error instanceof SnapshotSourceError &&
      error.failureKind === 'stale-target' &&
      error.failureCode === 'target-process-changed',
  );
  await manager.close();
});

test('typed guest failures retain their kind after target validation', async () => {
  const fixture = createLifecycleFixture({ responseErrorKind: 'application_not_responding' });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() }),
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'timeout',
  );
  await manager.close();
});

type LifecycleFixture = {
  host: SnapshotSourceHost;
  processes: FakeProcess[];
  sockets: FakeSocket[];
  diagnostics: Array<Parameters<SnapshotSourceHost['emitDiagnostic']>[0]>;
  socketPaths: string[];
};

function deadline(signal?: AbortSignal, timeoutMs = limits.maxDurationMs) {
  return createSnapshotSourceDeadline(timeoutMs, signal);
}

async function waitForDispatch(fixture: LifecycleFixture): Promise<void> {
  const startedAt = Date.now();
  while (fixture.sockets[0]?.writes !== 1) {
    if (Date.now() - startedAt >= 1000) throw new Error('Fixture request was not dispatched');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function createLifecycleFixture(
  options: {
    connectDelayMs?: number;
    responseDelayMs?: number;
    responsePid?: number;
    responseGeneration?: string;
    responseErrorKind?: string;
    targetStartTimes?: Array<string | null>;
  } = {},
): LifecycleFixture {
  const processes: FakeProcess[] = [];
  const sockets: FakeSocket[] = [];
  const diagnostics: LifecycleFixture['diagnostics'] = [];
  const socketPaths: string[] = [];
  const realHost = createSnapshotSourceHost();
  const host: SnapshotSourceHost = {
    ...realHost,
    emitDiagnostic: (event) => diagnostics.push(event),
    readTargetProcessStartTime: async () => options.targetStartTimes?.shift() ?? 'target-start',
    start: (_udid, _bridgePath, socketPath) => {
      socketPaths.push(socketPath);
      const process = new FakeProcess(700 + processes.length);
      processes.push(process);
      return process;
    },
    connect: async (_socketPath, connectOptions) => {
      if (options.connectDelayMs) {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: SnapshotSourceError) => {
            clearTimeout(timer);
            connectOptions.signal?.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve();
          };
          const timer = setTimeout(() => finish(), options.connectDelayMs);
          const onAbort = () => {
            finish(snapshotSourceError('cancelled', 'abort-signal'));
          };
          connectOptions.signal?.addEventListener('abort', onAbort, { once: true });
          if (connectOptions.signal?.aborted) onAbort();
        });
      }
      const socket = new FakeSocket(
        options.responseDelayMs ?? 0,
        options.responsePid ?? target.pid,
        options.responseGeneration,
        options.responseErrorKind,
      );
      sockets.push(socket);
      return socket;
    },
  };
  return { host, processes, sockets, diagnostics, socketPaths };
}

class FakeProcess implements SnapshotSourceProcess {
  alive = true;
  signals: NodeJS.Signals[] = [];
  readonly wait: Promise<{ stdout: string; stderr: string; exitCode: number }>;
  private readonly processId: number;
  private resolveWait!: (result: { stdout: string; stderr: string; exitCode: number }) => void;

  constructor(pid: number) {
    this.processId = pid;
    this.wait = new Promise((resolve) => {
      this.resolveWait = resolve;
    });
  }

  get pid(): number {
    return this.processId;
  }

  isAlive(): boolean {
    return this.alive;
  }

  signal(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    this.alive = false;
    this.resolveWait({ stdout: '', stderr: '', exitCode: signal === 'SIGKILL' ? 137 : 0 });
  }

  crash(): void {
    this.alive = false;
    this.resolveWait({ stdout: '', stderr: 'crashed', exitCode: 1 });
  }

  readLog(): string {
    return 'fixture log';
  }
}

class FakeSocket extends EventEmitter implements SnapshotSourceSocket {
  destroyed = false;
  writes = 0;
  private readonly responseDelayMs: number;
  private readonly responsePid: number;
  private readonly responseGeneration: string | undefined;
  private readonly responseErrorKind: string | undefined;

  constructor(
    responseDelayMs: number,
    responsePid: number,
    responseGeneration: string | undefined,
    responseErrorKind?: string,
  ) {
    super();
    this.responseDelayMs = responseDelayMs;
    this.responsePid = responsePid;
    this.responseGeneration = responseGeneration;
    this.responseErrorKind = responseErrorKind;
  }

  write(frame: Buffer): boolean {
    this.writes += 1;
    const bodyLength = frame.readUInt32BE(0);
    const request = JSON.parse(frame.subarray(4, bodyLength + 4).toString('utf8')) as {
      requestId: string;
      pid: number;
      generation: string;
    };
    setTimeout(() => {
      if (this.destroyed) return;
      this.emit(
        'data',
        encodeSnapshotBridgeFrame(
          this.responseErrorKind
            ? {
                protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
                sourceVersion: SNAPSHOT_SOURCE_VERSION,
                requestId: request.requestId,
                ok: false,
                pid: this.responsePid || request.pid,
                generation: this.responseGeneration ?? request.generation,
                error_kind: this.responseErrorKind,
                error_code: 'fixture-error',
              }
            : {
                protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
                sourceVersion: SNAPSHOT_SOURCE_VERSION,
                requestId: request.requestId,
                ok: true,
                pid: this.responsePid || request.pid,
                generation: this.responseGeneration ?? request.generation,
                truncated: false,
                automationEnabled: true,
                tree: {
                  XC_kAXXCAttributeElementType: 'Application',
                  XC_kAXXCAttributeChildren: [],
                },
              },
          limits,
        ),
      );
    }, this.responseDelayMs);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }
}
