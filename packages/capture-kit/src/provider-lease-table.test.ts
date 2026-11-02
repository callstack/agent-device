import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import {
  createProviderLeaseTable,
  type ProviderLeaseBoundedBudget,
  type ProviderLeaseCleanupScope,
  type ProviderLeaseStart,
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
 * `stopAnswers` when one is queued, and every call is recorded.
 */
function fakeProvider(options: { startTimeoutMs?: number } = {}) {
  const started: Array<Readonly<{ leaseId: string; budget: ProviderLeaseBoundedBudget }>> = [];
  const stopped: string[] = [];
  const found: string[] = [];
  const starts: Array<Deferred<ProviderLeaseStart<Session, Handle>>> = [];
  const stopAnswers: Array<() => Promise<void>> = [];
  let findAnswer: (lease: DeviceLease) => Promise<Handle> = async (lease) => ({
    id: `found-${lease.leaseId}`,
  });
  const table = createProviderLeaseTable<Session, Handle, Request>({
    startTimeoutMs: options.startTimeoutMs ?? 60_000,
    start: async (lease, _request, budget) => {
      started.push({ leaseId: lease.leaseId, budget });
      const answer = deferred<ProviderLeaseStart<Session, Handle>>();
      starts.push(answer);
      return await answer.promise;
    },
    stop: async (handle) => {
      stopped.push(handle.id);
      await stopAnswers.shift()?.();
    },
    findByLease: async (lease) => {
      found.push(lease.leaseId);
      return await findAnswer(lease);
    },
    shuttingDown: (lease) =>
      new TableError({ reason: 'runtime-shutting-down', leaseId: lease.leaseId }),
    gaveUp: (lease, budget, budgetMs, rented) =>
      new TableError({
        reason: budget.signal?.aborted ? 'request_canceled' : 'provider-not-ready',
        leaseId: lease.leaseId,
        budgetMs,
        rented: rented?.id,
      }),
    cleanupPending: (unconfirmed, scope: ProviderLeaseCleanupScope, cause) =>
      new TableError(
        {
          reason: 'provider-cleanup-pending',
          route: scope.route,
          handles: unconfirmed.map((stop) => stop.handle.id),
          causes: unconfirmed.map((stop) => String(stop.cause)),
        },
        cause,
      ),
  });
  return {
    table,
    started,
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

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('overlapping allocations of one lease share one start, and a repeat reuses its session', async () => {
  const provider = fakeProvider();
  const first = provider.table.allocate(lease(), {});
  const second = provider.table.allocate(lease(), {});
  await settle();
  assert.equal(provider.started.length, 1, 'one lease rents one device');
  assert.deepEqual(provider.table.requestOf('lease-1'), {});

  provider.answerStart(0, ready('session-1'));
  assert.deepEqual(await first, { id: 'session-1' });
  assert.deepEqual(await second, { id: 'session-1' });
  assert.deepEqual(await provider.table.allocate(lease(), {}), { id: 'session-1' });
  assert.equal(provider.started.length, 1);
});

test('a failed stop keeps the session for the retry that confirms it', async () => {
  const provider = fakeProvider();
  const allocating = provider.table.allocate(lease(), {});
  await settle();
  provider.answerStart(0, ready('session-1'));
  await allocating;

  provider.queueStop(async () => {
    throw new Error('backend down');
  });
  await assert.rejects(
    provider.table.release('lease-1'),
    reason('provider-cleanup-pending', 'release'),
  );
  assert.deepEqual(
    provider.table.live('lease-1'),
    { id: 'session-1' },
    'an unconfirmed stop forgets nothing',
  );

  assert.deepEqual(await provider.table.release('lease-1'), {
    handle: { id: 'session-1' },
    session: { id: 'session-1' },
  });
  assert.equal(provider.table.live('lease-1'), undefined);
  assert.equal(
    await provider.table.release('lease-1'),
    undefined,
    'a confirmed stop is not sent again',
  );
  assert.deepEqual(provider.stopped, ['session-1', 'session-1']);
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
  assert.equal(provider.table.live('lease-1'), undefined);
  assert.equal(await provider.table.release('lease-1'), undefined);
});

test('an aborted joiner leaves the shared start to the caller still waiting', async () => {
  const provider = fakeProvider();
  const first = provider.table.allocate(lease(), {});
  const controller = new AbortController();
  const joining = provider.table.allocate(lease(), {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(joining, reason('request_canceled'));

  provider.answerStart(0, ready('session-1'));
  assert.deepEqual(await first, { id: 'session-1' });
  assert.deepEqual(provider.stopped, []);
});

test('allocation is bounded by the earlier of the caller deadline and the provider timeout', async () => {
  const provider = fakeProvider({ startTimeoutMs: 40 });
  const before = Date.now();
  const unbounded = provider.table.allocate(lease('lease-1'), {});
  const shorter = provider.table.allocate(lease('lease-2'), {}, { deadline: Date.now() + 10 });
  await settle();
  const [timeoutBound, deadlineBound] = provider.started.map((start) => start.budget.deadline);
  assert.ok(timeoutBound! >= before + 40 && timeoutBound! <= Date.now() + 40);
  assert.ok(deadlineBound! <= before + 10 + 5);

  await assert.rejects(shorter, reason('provider-not-ready'));
  await assert.rejects(unbounded, reason('provider-not-ready'));

  // The device a late start names after the budget passed is stopped, never handed out.
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

  provider.queueStop(async () => {
    throw new Error('stop refused');
  });
  provider.answerStart(2, { status: 'failed', error: new Error('late'), rented: { id: 'r3' } });
  await assert.rejects(unstoppable, (error: unknown) => {
    assert.ok(reason('provider-cleanup-pending', 'start')(error));
    assert.deepEqual((error as TableError).details.handles, ['r3']);
    assert.match(String((error as TableError).cause), /late/);
    return true;
  });
  // The stop that failed stays owed, so a release retries it.
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
  assert.equal(provider.started.length, 1);
});

test('shutdown reports what it could not stop and keeps it for a later release', async () => {
  const provider = fakeProvider();
  const allocating = provider.table.allocate(lease(), {});
  await settle();
  provider.answerStart(0, ready('session-1'));
  await allocating;
  provider.queueStop(async () => {
    throw new Error('backend down');
  });

  await assert.rejects(provider.table.shutdown(), (error: unknown) => {
    assert.ok(reason('provider-cleanup-pending', 'shutdown')(error));
    assert.deepEqual((error as TableError).details.handles, ['session-1']);
    return true;
  });
  assert.equal((await provider.table.release('lease-1'))?.handle.id, 'session-1');
});

test('recovery stops what the provider finds for a lease this process never started', async () => {
  const provider = fakeProvider();
  await provider.table.recover(lease());
  assert.deepEqual(provider.found, ['lease-1']);
  assert.deepEqual(provider.stopped, ['found-lease-1']);

  provider.queueStop(async () => {
    throw new Error('backend down');
  });
  await assert.rejects(
    provider.table.recover(lease()),
    reason('provider-cleanup-pending', 'recover'),
  );
});

test('recovery that finds nothing rejects, so the lease stays pending', async () => {
  const provider = fakeProvider();
  const notFound = new Error('cannot search');
  provider.answerFind(async () => {
    throw notFound;
  });
  await assert.rejects(provider.table.recover(lease()), (error: unknown) => error === notFound);
  assert.deepEqual(provider.stopped, []);
});

test('a release, a recovery and a shutdown that overlap share one stop', async () => {
  const provider = fakeProvider();
  const allocating = provider.table.allocate(lease(), {});
  await settle();
  provider.answerStart(0, ready('session-1'));
  await allocating;

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
