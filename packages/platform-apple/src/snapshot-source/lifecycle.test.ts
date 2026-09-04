import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'vitest';
import { createSnapshotSourceHost } from './host.ts';
import { SnapshotSourceError, snapshotSourceError } from './errors.ts';
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

  await manager.request({ target, bridge, limits, maxDepth: 10 });
  await manager.request({ target, bridge, limits, maxDepth: 10 });

  assert.equal(fixture.processes.length, 1);
  assert.equal(fixture.sockets.length, 1);
  await manager.close();
  assert.deepEqual(fixture.processes[0]!.signals, ['SIGTERM']);
});

test('a new target generation does not reuse the previous helper', async () => {
  const fixture = createLifecycleFixture();
  const manager = new SnapshotBridgeManager(fixture.host);

  await manager.request({ target, bridge, limits, maxDepth: 10 });
  await manager.request({
    target: { ...target, generation: 'generation-2' },
    bridge,
    limits,
    maxDepth: 10,
  });

  assert.equal(fixture.processes.length, 2);
  assert.deepEqual(fixture.processes[0]!.signals, ['SIGTERM']);
  await manager.close();
  assert.deepEqual(fixture.processes[1]!.signals, ['SIGTERM']);
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
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    request,
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'cancelled',
  );
  assert.deepEqual(fixture.processes[0]?.signals, ['SIGTERM']);
  assert.equal(fixture.processes[0]?.alive, false);
  await manager.request({ target, bridge, limits, maxDepth: 10 });
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
  });
  fixture.sockets[0]!.destroy();

  const controller = new AbortController();
  const request = manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 500 },
    maxDepth: 10,
    signal: controller.signal,
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
    }),
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'timeout',
  );
  assert.deepEqual(fixture.processes[0]?.signals, ['SIGTERM']);
  await manager.close();
});

test('a crashed helper is removed and the next request starts a fresh helper', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 80 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({ target, bridge, limits, maxDepth: 10 });
  setTimeout(() => fixture.processes[0]?.crash(), 10);

  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof SnapshotSourceError && error.failureKind === 'process-crash',
  );
  assert.equal(fixture.processes[0]?.signals.length, 0);

  await manager.request({ target, bridge, limits, maxDepth: 10 });
  assert.equal(fixture.processes.length, 2);
  await manager.close();
});

test('the manager rejects a response for a different target process as stale', async () => {
  const fixture = createLifecycleFixture({ responsePid: target.pid + 1 });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10 }),
    (error: unknown) =>
      error instanceof SnapshotSourceError && error.failureKind === 'stale-target',
  );
  await manager.close();
});

test('the manager rejects a response carrying a previous target generation as stale', async () => {
  const fixture = createLifecycleFixture({ responseGeneration: 'generation-0' });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10 }),
    (error: unknown) =>
      error instanceof SnapshotSourceError &&
      error.failureKind === 'stale-target' &&
      error.failureCode === 'bridge-generation-mismatch',
  );
  await manager.close();
});

test('typed guest failures retain their kind after target validation', async () => {
  const fixture = createLifecycleFixture({ responseErrorKind: 'application_not_responding' });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10 }),
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'timeout',
  );
  await manager.close();
});

type LifecycleFixture = {
  host: SnapshotSourceHost;
  processes: FakeProcess[];
  sockets: FakeSocket[];
};

function createLifecycleFixture(
  options: {
    connectDelayMs?: number;
    responseDelayMs?: number;
    responsePid?: number;
    responseGeneration?: string;
    responseErrorKind?: string;
  } = {},
): LifecycleFixture {
  const processes: FakeProcess[] = [];
  const sockets: FakeSocket[] = [];
  const realHost = createSnapshotSourceHost();
  const host: SnapshotSourceHost = {
    ...realHost,
    start: () => {
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
  return { host, processes, sockets };
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
