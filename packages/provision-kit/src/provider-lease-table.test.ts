import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import {
  createProviderLeaseTable,
  type ProviderLeaseCleanupScope,
  type ProviderLeaseStart,
  type ProviderLeaseStartControl,
} from './provider-lease-table.ts';

type Session = Readonly<{ id: string }>;
type Handle = Readonly<{ id: string }>;
type Request = Readonly<{ app?: string }>;

class TableError extends Error {
  readonly details: Readonly<Record<string, unknown>>;
  constructor(details: Readonly<Record<string, unknown>>, cause?: unknown) {
    super(String(details.reason), { cause });
    this.details = details;
  }
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/**
 * A provider whose starts and stops the test answers by hand. Each start waits on `starts`, each stop on
 * the next queued answer when one is queued, and every call is recorded.
 */
function fakeProvider(options: { startTimeoutMs?: number; stopTimeoutMs?: number } = {}) {
  const controls: Array<ProviderLeaseStartControl<Handle>> = [];
  const stopped: string[] = [];
  const found: string[] = [];
  const starts: Array<Deferred<ProviderLeaseStart<Session, Handle>>> = [];
  const stopAnswers: Array<() => Promise<void>> = [];
  let findAnswer: (lease: DeviceLease) => Promise<Handle> = async (lease) => ({
    id: `found-${lease.leaseId}`,
  });
  const table = createProviderLeaseTable<Session, Handle, Request>({
    startTimeoutMs: options.startTimeoutMs ?? 60_000,
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
    start: async (_lease, _request, control) => {
      controls.push(control);
      const answer = deferred<ProviderLeaseStart<Session, Handle>>();
      starts.push(answer);
      return await answer.promise;
    },
    stop: async (handle) => {
      stopped.push(handle.id);
      await stopAnswers.shift()?.();
    },
    handleKey: (handle) => handle.id,
    findByLease: async (lease) => {
      found.push(lease.leaseId);
      return await findAnswer(lease);
    },
    shuttingDown: (lease) =>
      new TableError({ reason: 'runtime-shutting-down', leaseId: lease.leaseId }),
    releasing: (lease) => new TableError({ reason: 'lease-releasing', leaseId: lease.leaseId }),
    gaveUp: (lease, caller, budgetMs, rented) =>
      new TableError({
        reason: caller.signal?.aborted ? 'request_canceled' : 'provider-not-ready',
        leaseId: lease.leaseId,
        budgetMs,
        callerDeadline: caller.deadline,
        rented: rented?.id,
      }),
    cleanupPending: (unconfirmed, scope: ProviderLeaseCleanupScope, cause) =>
      new TableError(
        {
          reason: 'provider-cleanup-pending',
          route: scope.route,
          handles: unconfirmed.map((stop) => stop.handle?.id ?? `unnamed-${stop.leaseId}`),
        },
        cause,
      ),
  });
  return {
    table,
    controls,
    stopped,
    found,
    /** Answers the n-th start, in the order the starts were sent. */
    answerStart(index: number, answer: ProviderLeaseStart<Session, Handle>) {
      starts[index]!.resolve(answer);
    },
    failStart(index: number, error: unknown) {
      starts[index]!.reject(error);
    },
    queueStop(answer: () => Promise<void>) {
      stopAnswers.push(answer);
    },
    answerFind(answer: (lease: DeviceLease) => Promise<Handle>) {
      findAnswer = answer;
    },
  };
}

function lease(leaseId = 'lease-1'): DeviceLease {
  return {
    leaseId,
    tenantId: 'tenant',
    runId: 'run',
    backend: 'ios-instance',
    leaseProvider: 'fake-cloud',
    createdAt: 0,
    heartbeatAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

function ready(id: string): ProviderLeaseStart<Session, Handle> {
  return { status: 'ready', session: { id }, handle: { id } };
}

function reason(expected: string, route?: string) {
  return (error: unknown) =>
    error instanceof TableError &&
    error.details.reason === expected &&
    (route === undefined || error.details.route === route);
}

function refusedStop() {
  return async () => {
    throw new Error('backend down');
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function allocated(provider: ReturnType<typeof fakeProvider>, id = 'session-1') {
  const allocating = provider.table.allocate(lease(), {});
  await settle();
  provider.answerStart(provider.controls.length - 1, ready(id));
  return await allocating;
}

test('overlapping allocations of one lease share one start, and a repeat reuses its session', async () => {
  const provider = fakeProvider();
  const first = provider.table.allocate(lease(), { app: 'a' });
  const second = provider.table.allocate(lease(), {}, { requireJoinable: () => undefined });
  await assert.rejects(
    provider.table.allocate(
      lease(),
      { app: 'b' },
      {
        requireJoinable: (started) => {
          throw new Error(`started for ${started.app}`);
        },
      },
    ),
    /started for a/,
  );
  await settle();
  assert.equal(provider.controls.length, 1, 'one lease rents one device');

  provider.answerStart(0, ready('session-1'));
  assert.deepEqual(await first, { id: 'session-1' });
  assert.deepEqual(await second, { id: 'session-1' });
  assert.deepEqual(await provider.table.allocate(lease(), {}), { id: 'session-1' });
  // Reusing the ready session is checked the same way as joining the start.
  await assert.rejects(
    provider.table.allocate(
      lease(),
      { app: 'b' },
      {
        requireJoinable: () => {
          throw new Error('different request');
        },
      },
    ),
    /different request/,
  );
  assert.equal(provider.controls.length, 1);
});

test('a failed stop keeps the lease for the retry that confirms it, and serves no allocation', async () => {
  const provider = fakeProvider();
  await allocated(provider);

  provider.queueStop(refusedStop());
  await assert.rejects(
    provider.table.release('lease-1'),
    reason('provider-cleanup-pending', 'release'),
  );
  assert.equal(provider.table.live('lease-1'), undefined);
  await assert.rejects(provider.table.allocate(lease(), {}), reason('lease-releasing'));

  assert.deepEqual(await provider.table.release('lease-1'), {
    handle: { id: 'session-1' },
    session: { id: 'session-1' },
  });
  assert.equal(
    await provider.table.release('lease-1'),
    undefined,
    'a confirmed stop is not sent again',
  );
  assert.deepEqual(provider.stopped, ['session-1', 'session-1']);
});

test('an allocation that arrives while a release stops the device is refused', async () => {
  const provider = fakeProvider();
  await allocated(provider);
  const stop = deferred<void>();
  provider.queueStop(async () => await stop.promise);

  // One reuses the live session in the tick before the release starts, one arrives after it started:
  // neither is handed a device that is being stopped.
  const reusing = provider.table.allocate(lease(), {});
  const releasing = provider.table.release('lease-1');
  await assert.rejects(reusing, reason('lease-releasing'));
  await assert.rejects(provider.table.allocate(lease(), {}), reason('lease-releasing'));
  stop.resolve();
  assert.equal((await releasing)?.handle.id, 'session-1');

  // Once the stop is confirmed the lease id is free, and a new allocation rents a new device.
  const fresh = provider.table.allocate(lease(), {});
  await settle();
  provider.answerStart(1, ready('session-2'));
  assert.deepEqual(await fresh, { id: 'session-2' });
});

test('a release during a start refuses the waiting allocation and stops the device it rents', async () => {
  const provider = fakeProvider();
  const allocating = provider.table.allocate(lease(), {});
  const refused = assert.rejects(allocating, reason('lease-releasing'));
  await settle();

  const releasing = provider.table.release('lease-1');
  await settle();
  assert.deepEqual(provider.stopped, [], 'the stop waits for the answer that names the device');
  provider.answerStart(0, ready('session-1'));
  assert.deepEqual(await releasing, {
    handle: { id: 'session-1' },
    session: { id: 'session-1' },
  });
  await refused;
  assert.deepEqual(provider.stopped, ['session-1']);
});

test('a caller that aborts mid-start is answered at once, and the late device is stopped', async () => {
  const provider = fakeProvider();
  const controller = new AbortController();
  const allocating = provider.table.allocate(lease(), {}, { signal: controller.signal });
  await settle();
  controller.abort();
  await assert.rejects(allocating, reason('request_canceled'));
  assert.deepEqual(provider.stopped, [], 'nothing is named until the start answers');

  provider.answerStart(0, ready('session-1'));
  await settle();
  assert.deepEqual(provider.stopped, ['session-1']);
  assert.equal(await provider.table.release('lease-1'), undefined);
});

test("a ready answer after the only caller's deadline is stopped, even before its timer fires", async () => {
  // The clock moves past the deadline without running timers, which is a busy event loop: the caller's
  // own give-up has not run yet when the start answers.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const provider = fakeProvider();
    const allocating = provider.table.allocate(lease(), {}, { deadline: Date.now() + 100 });
    const refused = assert.rejects(allocating, reason('provider-not-ready'));
    await settle();
    vi.setSystemTime(Date.now() + 200);
    provider.answerStart(0, ready('session-1'));
    await refused;
    await settle();
    assert.deepEqual(provider.stopped, ['session-1']);
  } finally {
    vi.useRealTimers();
  }
});

test('a caller whose budget is already spent sends no start', async () => {
  const provider = fakeProvider();
  await assert.rejects(
    provider.table.allocate(lease('lease-1'), {}, { deadline: Date.now() - 1 }),
    reason('provider-not-ready'),
  );
  await assert.rejects(
    provider.table.allocate(lease('lease-2'), {}, { signal: AbortSignal.abort() }),
    reason('request_canceled'),
  );
  await settle();
  assert.equal(provider.controls.length, 0);
});

test('a joiner still waiting keeps the device when the caller that started it gives up', async () => {
  const provider = fakeProvider();
  const controller = new AbortController();
  const first = provider.table.allocate(lease(), {}, { signal: controller.signal });
  const joining = provider.table.allocate(lease(), {});
  controller.abort();
  await assert.rejects(first, reason('request_canceled'));

  provider.answerStart(0, ready('session-1'));
  assert.deepEqual(await joining, { id: 'session-1' });
  assert.deepEqual(provider.stopped, []);
});

test('allocation is bounded by the earlier of the caller deadline and the provider timeout', async () => {
  const provider = fakeProvider({ startTimeoutMs: 40 });
  const before = Date.now();
  const unbounded = provider.table.allocate(lease('lease-1'), {});
  const callerDeadline = Date.now() + 10;
  const shorter = provider.table.allocate(lease('lease-2'), {}, { deadline: callerDeadline });
  const after = Date.now();
  await settle();
  const [timeoutBound, deadlineBound] = provider.controls.map((control) => control.deadline);
  assert.ok(timeoutBound! >= before + 40 && timeoutBound! <= after + 40);
  assert.equal(deadlineBound, callerDeadline);
  assert.deepEqual(provider.controls[0]!.caller, {}, 'the start sees the budget the caller asked');

  await assert.rejects(shorter, (error: unknown) => {
    assert.ok(reason('provider-not-ready')(error));
    assert.equal((error as TableError).details.callerDeadline, callerDeadline);
    return true;
  });
  await assert.rejects(unbounded, (error: unknown) => {
    assert.ok(reason('provider-not-ready')(error));
    assert.equal(
      (error as TableError).details.callerDeadline,
      undefined,
      'a caller that named no deadline is not reported one',
    );
    return true;
  });

  // The device a start names after every caller gave up is stopped, never handed out.
  provider.answerStart(0, ready('session-1'));
  provider.answerStart(1, ready('session-2'));
  await settle();
  assert.deepEqual(provider.stopped.sort(), ['session-1', 'session-2']);
});

test('a failed start is stopped before its failure reaches the caller', async () => {
  const provider = fakeProvider();
  const refused = provider.table.allocate(lease('lease-1'), {});
  const rented = provider.table.allocate(lease('lease-2'), {});
  const unstoppable = provider.table.allocate(lease('lease-3'), {});
  await settle();
  provider.answerStart(0, { status: 'failed', error: new Error('refused') });
  await assert.rejects(refused, /refused/);
  assert.deepEqual(provider.stopped, [], 'a refused start rented nothing');

  provider.answerStart(1, {
    status: 'failed',
    error: new Error('not ready'),
    rented: { id: 'r2' },
  });
  await assert.rejects(rented, /not ready/);
  assert.deepEqual(provider.stopped, ['r2']);

  provider.queueStop(refusedStop());
  provider.answerStart(2, { status: 'failed', error: new Error('late'), rented: { id: 'r3' } });
  await assert.rejects(unstoppable, (error: unknown) => {
    assert.ok(reason('provider-cleanup-pending', 'start')(error));
    assert.deepEqual((error as TableError).details.handles, ['r3']);
    assert.match(String((error as TableError).cause), /late/);
    return true;
  });
  // The stop that failed stays owed: the lease serves no allocation, and a release retries it.
  await assert.rejects(provider.table.allocate(lease('lease-3'), {}), reason('lease-releasing'));
  assert.deepEqual(await provider.table.release('lease-3'), {
    handle: { id: 'r3' },
    session: undefined,
  });
});

test('a start that rejects is cleaned up by the handle the provider finds for its lease', async () => {
  const provider = fakeProvider();
  const allocating = provider.table.allocate(lease(), {});
  await settle();
  provider.failStart(0, new Error('lost answer'));
  await assert.rejects(allocating, /lost answer/);
  assert.deepEqual(provider.found, ['lease-1']);
  assert.deepEqual(provider.stopped, ['found-lease-1']);
});

test('a lost start answer the provider cannot find keeps the lease until a retry finds it', async () => {
  const provider = fakeProvider();
  provider.answerFind(async () => {
    throw new Error('search failed');
  });
  const allocating = provider.table.allocate(lease(), {});
  await settle();
  provider.failStart(0, new Error('lost answer'));
  await assert.rejects(allocating, (error: unknown) => {
    assert.ok(reason('provider-cleanup-pending', 'start')(error));
    assert.deepEqual((error as TableError).details.handles, ['unnamed-lease-1']);
    return true;
  });
  // The rental may exist, so nothing rents a second device and nothing reports the lease released.
  await assert.rejects(provider.table.allocate(lease(), {}), reason('lease-releasing'));
  await assert.rejects(
    provider.table.release('lease-1'),
    reason('provider-cleanup-pending', 'release'),
  );
  await assert.rejects(provider.table.shutdown(), reason('provider-cleanup-pending', 'shutdown'));

  provider.answerFind(async () => ({ id: 'found-late' }));
  assert.deepEqual(await provider.table.release('lease-1'), {
    handle: { id: 'found-late' },
    session: undefined,
  });
  assert.deepEqual(provider.stopped, ['found-late']);
  assert.equal(provider.controls.length, 1);
});

test('a published rental is stopped when its start stalls, and the late answer ends the lease', async () => {
  const provider = fakeProvider({ startTimeoutMs: 30 });
  const allocating = provider.table.allocate(lease(), {});
  const gaveUp = assert.rejects(allocating, reason('provider-not-ready'));
  await settle();
  provider.controls[0]!.rented({ id: 'instance-1' });

  await assert.rejects(provider.table.release('lease-1'), (error: unknown) => {
    assert.ok(reason('provider-cleanup-pending', 'release')(error));
    assert.deepEqual((error as TableError).details.handles, ['instance-1']);
    return true;
  });
  await gaveUp;
  assert.deepEqual(provider.stopped, ['instance-1'], 'the stalled rental is stopped by its handle');
  // The start may still rent, so the lease id is not handed to a new allocation meanwhile.
  await assert.rejects(provider.table.allocate(lease(), {}), reason('lease-releasing'));
  assert.equal(provider.controls.length, 1);

  // The start finally answers with the same rental: it is already stopped, so the lease ends.
  provider.answerStart(0, ready('instance-1'));
  await settle();
  assert.equal(await provider.table.release('lease-1'), undefined);
  assert.deepEqual(provider.stopped, ['instance-1']);
});

test('a stop that outlives its budget is joined by the retry instead of sent twice', async () => {
  const provider = fakeProvider({ stopTimeoutMs: 20 });
  await allocated(provider);
  const stop = deferred<void>();
  provider.queueStop(async () => await stop.promise);

  await assert.rejects(
    provider.table.release('lease-1'),
    reason('provider-cleanup-pending', 'release'),
  );
  const retry = provider.table.release('lease-1');
  stop.resolve();
  assert.equal((await retry)?.handle.id, 'session-1');
  assert.deepEqual(provider.stopped, ['session-1']);
});

test('shutdown waits for an in-flight allocation, stops its device, and refuses new ones', async () => {
  const provider = fakeProvider();
  const allocating = provider.table.allocate(lease(), {});
  const refusal = assert.rejects(allocating, reason('runtime-shutting-down'));
  await settle();

  const shutdown = provider.table.shutdown();
  await settle();
  assert.deepEqual(provider.stopped, [], 'the drain waits for the start to name its device');
  provider.answerStart(0, ready('session-1'));
  await shutdown;
  await refusal;
  assert.deepEqual(provider.stopped, ['session-1']);

  await assert.rejects(
    provider.table.allocate(lease('lease-2'), {}),
    reason('runtime-shutting-down'),
  );
  assert.equal(provider.controls.length, 1);
});

test('shutdown also ends a lease that a recovery opens while it drains', async () => {
  const provider = fakeProvider();
  await allocated(provider);
  const stop = deferred<void>();
  provider.queueStop(async () => await stop.promise);
  // The recovery's own stop fails, and so does the drain's retry of it.
  provider.queueStop(refusedStop());
  provider.queueStop(refusedStop());

  const shutdown = provider.table.shutdown();
  await settle();
  const recovery = assert.rejects(
    provider.table.recover(lease('lease-2')),
    reason('provider-cleanup-pending', 'recover'),
  );
  stop.resolve();
  await assert.rejects(shutdown, (error: unknown) => {
    assert.ok(reason('provider-cleanup-pending', 'shutdown')(error));
    assert.deepEqual((error as TableError).details.handles, ['found-lease-2']);
    return true;
  });
  await recovery;
  assert.deepEqual(provider.stopped, ['session-1', 'found-lease-2', 'found-lease-2']);
});

test('shutdown reports what it could not stop and keeps it for a later release', async () => {
  const provider = fakeProvider();
  await allocated(provider);
  provider.queueStop(refusedStop());

  await assert.rejects(provider.table.shutdown(), (error: unknown) => {
    assert.ok(reason('provider-cleanup-pending', 'shutdown')(error));
    assert.deepEqual((error as TableError).details.handles, ['session-1']);
    return true;
  });
  assert.equal((await provider.table.release('lease-1'))?.handle.id, 'session-1');
});

test('recovery stops what the provider finds, and keeps that handle when the stop fails', async () => {
  const provider = fakeProvider();
  provider.queueStop(refusedStop());
  await assert.rejects(
    provider.table.recover(lease()),
    reason('provider-cleanup-pending', 'recover'),
  );
  await provider.table.recover(lease());
  assert.deepEqual(provider.found, ['lease-1'], 'the handle found once is the one retried');
  assert.deepEqual(provider.stopped, ['found-lease-1', 'found-lease-1']);
});

test('recovery that finds nothing rejects, so the lease stays pending', async () => {
  const provider = fakeProvider();
  const notFound = new Error('cannot search');
  provider.answerFind(async () => {
    throw notFound;
  });
  await assert.rejects(provider.table.recover(lease()), (error: unknown) => {
    assert.ok(reason('provider-cleanup-pending', 'recover')(error));
    assert.equal((error as TableError).cause, undefined);
    return true;
  });
  assert.deepEqual(provider.stopped, []);
});

test('recoveries, a release, and a shutdown of an entryless lease share one lookup and one stop', async () => {
  const provider = fakeProvider();
  const stop = deferred<void>();
  provider.queueStop(async () => await stop.promise);

  const ending = Promise.all([
    provider.table.recover(lease()),
    provider.table.recover(lease()),
    provider.table.release('lease-1'),
    provider.table.shutdown(),
  ]);
  await settle();
  await assert.rejects(provider.table.allocate(lease(), {}), reason('runtime-shutting-down'));
  stop.resolve();
  const [, , released] = await ending;
  assert.equal(released?.handle.id, 'found-lease-1');
  assert.deepEqual(provider.found, ['lease-1']);
  assert.deepEqual(provider.stopped, ['found-lease-1']);
});

test('a release, a recovery and a shutdown that overlap share one stop', async () => {
  const provider = fakeProvider();
  await allocated(provider);

  const stop = deferred<void>();
  provider.queueStop(async () => await stop.promise);
  const ending = Promise.all([
    provider.table.release('lease-1'),
    provider.table.recover(lease()),
    provider.table.shutdown(),
  ]);
  await settle();
  stop.resolve();
  await ending;
  assert.deepEqual(provider.stopped, ['session-1']);
  assert.deepEqual(provider.found, [], 'a lease this process holds is not searched for');
});
