import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import {
  createProviderLeaseSessionTable,
  providerLeaseFailureReason,
  type ProviderLeaseFailureReason,
  type ProviderLeaseRejection,
  type ProviderLeaseSearch,
  type ProviderLeaseSessionDriver,
} from './provider-lease-sessions.ts';

/**
 * The table's own contract, without a provider in front of it: what one lease id may rent, what a
 * release may forget, and what a drain may report as clean. Each case drives the table through the
 * driver seam and asserts on what the driver saw.
 */

type FakeSession = Readonly<{ leaseId: string; id: number }>;
type FakeSearch = Readonly<{ instanceIds: readonly string[] }>;
type FakeRequest = Readonly<{ leaseId: string }>;

type FakeDriver = ProviderLeaseSessionDriver<FakeSession, FakeSearch, FakeRequest> & {
  calls: {
    starts: string[];
    stops: string[];
    searches: string[];
    recovered: FakeSearch[];
    reused: string[];
  };
  /** Makes the next `stop` reject once, so a release retry can be observed. */
  failNextStop: (error: Error) => void;
  /** Makes the next `describeRelease` reject once, so a release failing before the stop is seen. */
  failNextDescribeRelease: (error: Error) => void;
  /** Holds the next `start` open until the test releases it. */
  holdNextStart: () => () => void;
  /** Holds the next `stop` open until the test releases it. */
  holdNextStop: () => () => void;
  reportSearch: (search: ProviderLeaseSearch<FakeSearch>) => void;
};

function fakeDriver(): FakeDriver {
  const calls = {
    starts: [] as string[],
    stops: [] as string[],
    searches: [] as string[],
    recovered: [] as FakeSearch[],
    reused: [] as string[],
  };
  let nextStartGate: Promise<void> | undefined;
  let nextStopGate: Promise<void> | undefined;
  let stopFailure: Error | undefined;
  let describeReleaseFailure: Error | undefined;
  let search: ProviderLeaseSearch<FakeSearch> = { status: 'absent' };
  let sequence = 0;
  return {
    calls,
    failNextStop: (error) => {
      stopFailure = error;
    },
    failNextDescribeRelease: (error) => {
      describeReleaseFailure = error;
    },
    holdNextStart: () => {
      let release!: () => void;
      nextStartGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    holdNextStop: () => {
      let release!: () => void;
      nextStopGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    reportSearch: (next) => {
      search = next;
    },
    prepare: () => undefined,
    start: async (request, control) => {
      calls.starts.push(request.leaseId);
      const held = nextStartGate;
      if (held) {
        nextStartGate = undefined;
        await held;
      }
      const session = { leaseId: request.leaseId, id: ++sequence };
      control.adopt(session);
      return { started: session.id };
    },
    reuse: async (session, request) => {
      calls.reused.push(request.leaseId);
      return { reused: session.id };
    },
    describeRelease: async (session) => {
      if (describeReleaseFailure) {
        const error = describeReleaseFailure;
        describeReleaseFailure = undefined;
        throw error;
      }
      return { released: session.id };
    },
    stop: async (session) => {
      calls.stops.push(session.leaseId);
      const held = nextStopGate;
      if (held) {
        nextStopGate = undefined;
        await held;
      }
      if (stopFailure) {
        const error = stopFailure;
        stopFailure = undefined;
        throw error;
      }
    },
    searchLease: async (request) => {
      calls.searches.push(request.leaseId);
      return search;
    },
    stopLease: async (found) => {
      calls.recovered.push(found);
      return { stopped: true, artifacts: { instanceCount: found.instanceIds.length } };
    },
    reject: (rejection: ProviderLeaseRejection, reason: ProviderLeaseFailureReason) => {
      const error = new Error(JSON.stringify({ rejection, reason }));
      if ('cause' in rejection) error.cause = rejection.cause;
      return error;
    },
  };
}

/** What the table handed the driver's `reject`, and the shared reason it mapped the rejection to. */
type ReportedRejection = Readonly<{
  rejection: ProviderLeaseRejection;
  reason: ProviderLeaseFailureReason;
}>;

function reported(error: unknown): ReportedRejection {
  return JSON.parse((error as Error).message) as ReportedRejection;
}

function rejectionReason(error: unknown): string | undefined {
  return reported(error).rejection.reason;
}

function causeMessage(error: unknown): string | undefined {
  return (error as { cause?: { message?: string } }).cause?.message;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('provider lease session table', () => {
  test('one lease id rents one device, and a caller that arrives mid-allocation joins it', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    const hold = driver.holdNextStart();

    const first = table.allocate({ leaseId: 'lease-1' }, 'lease-1');
    const second = table.allocate({ leaseId: 'lease-1' }, 'lease-1');
    hold();

    assert.deepEqual(await Promise.all([first, second]), [{ started: 1 }, { started: 1 }]);
    assert.deepEqual(driver.calls.starts, ['lease-1']);
    assert.deepEqual(await table.release({ leaseId: 'lease-1' }, 'lease-1'), { released: 1 });
  });

  test('a repeat allocation of a live lease reuses its session instead of renting again', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    await table.allocate({ leaseId: 'lease-1' }, 'lease-1');

    assert.deepEqual(await table.allocate({ leaseId: 'lease-1' }, 'lease-1'), { reused: 1 });
    assert.deepEqual(driver.calls.starts, ['lease-1']);
    assert.deepEqual(driver.calls.reused, ['lease-1']);
  });

  test('a request the provider refuses never reaches the device, not even a session in reuse', async () => {
    const driver = fakeDriver();
    const refused = new Error('profile field refused');
    const table = createProviderLeaseSessionTable({
      ...driver,
      prepare: async (request) => {
        if (request.leaseId === 'lease-2') throw refused;
      },
    });
    await table.allocate({ leaseId: 'lease-1' }, 'lease-1');

    await assert.rejects(
      () => table.allocate({ leaseId: 'lease-2' }, 'lease-2'),
      /profile field refused/,
    );
    assert.deepEqual(driver.calls.starts, ['lease-1']);
    assert.deepEqual(driver.calls.reused, []);
    assert.deepEqual(driver.calls.stops, []);
  });

  test('a failed allocation rents again for the next caller', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable({
      ...driver,
      start: async (request, control) => {
        if (driver.calls.starts.length === 0) {
          driver.calls.starts.push(request.leaseId);
          throw new Error('rent refused');
        }
        return await driver.start(request, control);
      },
    });

    await assert.rejects(() => table.allocate({ leaseId: 'lease-1' }, 'lease-1'), /rent refused/);
    assert.deepEqual(await table.allocate({ leaseId: 'lease-1' }, 'lease-1'), { started: 1 });
  });

  test('an unconfirmed stop keeps the session so the next release can finish it', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    await table.allocate({ leaseId: 'lease-1' }, 'lease-1');
    driver.failNextStop(new Error('temporary delete failure'));

    await assert.rejects(
      () => table.release({ leaseId: 'lease-1' }, 'lease-1'),
      (error: unknown) =>
        rejectionReason(error) === 'provider-stop-unconfirmed' &&
        // The provider's own failure travels as the cause, so a caller can tell a temporary refusal.
        causeMessage(error) === 'temporary delete failure',
    );

    assert.deepEqual(await table.release({ leaseId: 'lease-1' }, 'lease-1'), { released: 1 });
    assert.deepEqual(driver.calls.stops, ['lease-1', 'lease-1']);
    assert.equal(table.find('lease-1'), undefined);
  });

  test('a release that fails before the stop keeps the session and stops nothing', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    await table.allocate({ leaseId: 'lease-1' }, 'lease-1');
    driver.failNextDescribeRelease(new Error('capture close refused'));

    await assert.rejects(
      () => table.release({ leaseId: 'lease-1' }, 'lease-1'),
      (error: unknown) =>
        rejectionReason(error) === 'provider-stop-unconfirmed' &&
        causeMessage(error) === 'capture close refused',
    );
    assert.deepEqual(driver.calls.stops, []);
    assert.notEqual(table.find('lease-1'), undefined);
    assert.deepEqual(await table.release({ leaseId: 'lease-1' }, 'lease-1'), { released: 1 });
  });

  test('two releases of one session stop the device once', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    await table.allocate({ leaseId: 'lease-1' }, 'lease-1');

    await Promise.all([
      table.release({ leaseId: 'lease-1' }, 'lease-1'),
      table.release({ leaseId: 'lease-1' }, 'lease-1'),
    ]);

    assert.deepEqual(driver.calls.stops, ['lease-1']);
  });

  test('an allocation that outlives the caller deadline stops the device it rented', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);

    const late = table.allocate({ leaseId: 'lease-1' }, 'lease-1', { deadlineAt: 500 });

    await assert.rejects(
      () => late,
      (error: unknown) => rejectionReason(error) === 'provider-start-deadline-exceeded',
    );
    assert.deepEqual(driver.calls.stops, ['lease-1']);
    // The device is gone from the table, so a release has nothing left to forget.
    assert.equal(table.find('lease-1'), undefined);
  });

  test('an unconfirmed stop on an overdue allocation reports cleanup pending, not a deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const driver = fakeDriver();
    driver.failNextStop(new Error('delete refused'));
    const table = createProviderLeaseSessionTable(driver);

    await assert.rejects(
      () => table.allocate({ leaseId: 'lease-1' }, 'lease-1', { deadlineAt: 500 }),
      (error: unknown) => rejectionReason(error) === 'provider-stop-unconfirmed',
    );
    // The session survives: its device is still rented and a later release must find it.
    assert.notEqual(table.find('lease-1'), undefined);
  });

  test('an allocation the caller cancels stops the device the rental adopted', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    const hold = driver.holdNextStart();
    const cancelled = new AbortController();
    const cancelling = table.allocate({ leaseId: 'lease-1' }, 'lease-1', {
      signal: cancelled.signal,
    });

    cancelled.abort();
    hold();

    await assert.rejects(
      () => cancelling,
      (error: unknown) => rejectionReason(error) === 'provider-allocation-cancelled',
    );
    assert.deepEqual(driver.calls.stops, ['lease-1']);
    assert.equal(table.find('lease-1'), undefined);
  });

  test('an allocation cancelled before it starts still gives back what the provider rented', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    const cancelled = new AbortController();
    cancelled.abort();

    await assert.rejects(
      () => table.allocate({ leaseId: 'lease-1' }, 'lease-1', { signal: cancelled.signal }),
      (error: unknown) => rejectionReason(error) === 'provider-allocation-cancelled',
    );
    assert.deepEqual(driver.calls.stops, ['lease-1']);
  });

  test('an allocation in flight is waited on before the drain stops anything', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    const hold = driver.holdNextStart();
    const allocating = table.allocate({ leaseId: 'lease-1' }, 'lease-1');

    let drained = false;
    const draining = table.shutdown().then(
      () => {
        drained = true;
      },
      () => {
        drained = true;
      },
    );
    await Promise.resolve();
    assert.equal(drained, false);
    assert.deepEqual(driver.calls.stops, []);

    hold();
    await allocating;
    await draining;

    assert.deepEqual(driver.calls.starts, ['lease-1']);
    assert.deepEqual(driver.calls.stops, ['lease-1']);
    // The drain also closes the table: a lease allocated after it takes no device.
    await assert.rejects(
      () => table.allocate({ leaseId: 'lease-2' }, 'lease-2'),
      (error: unknown) => rejectionReason(error) === 'provider-runtime-shutting-down',
    );
  });

  test('a release in flight is waited on before the drain stops anything', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    await table.allocate({ leaseId: 'lease-1' }, 'lease-1');
    const hold = driver.holdNextStop();
    const releasing = table.release({ leaseId: 'lease-1' }, 'lease-1');

    let drained = false;
    const draining = table.shutdown().then(
      () => {
        drained = true;
      },
      () => {
        drained = true;
      },
    );
    await Promise.resolve();
    assert.equal(drained, false);

    hold();
    await releasing;
    await draining;

    assert.deepEqual(driver.calls.stops, ['lease-1']);
  });

  test('a drain reports the sessions it could not stop by lease id and keeps them for a retry', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    await table.allocate({ leaseId: 'lease-1' }, 'lease-1');
    await table.allocate({ leaseId: 'lease-2' }, 'lease-2');
    driver.failNextStop(new Error('delete refused'));

    await assert.rejects(
      () => table.shutdown(),
      (error: unknown) =>
        rejectionReason(error) === 'provider-drain-unconfirmed' &&
        // A drain that could not confirm names the leases, and reports them as pending cleanup.
        JSON.stringify(reported(error)) ===
          JSON.stringify({
            rejection: { reason: 'provider-drain-unconfirmed', leaseIds: ['lease-1'] },
            reason: 'provider-cleanup-pending',
          }),
    );
    assert.notEqual(table.find('lease-1'), undefined);
    assert.equal(table.find('lease-2'), undefined);

    // The survivor is still there for the next drain, which confirms it.
    await table.shutdown();
    assert.equal(table.find('lease-1'), undefined);
  });

  test('a release made while a stop is in flight rents afresh once that stop confirmed', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    await table.allocate({ leaseId: 'lease-1' }, 'lease-1');
    const hold = driver.holdNextStop();
    const releasing = table.release({ leaseId: 'lease-1' }, 'lease-1');

    const reallocating = table.allocate({ leaseId: 'lease-1' }, 'lease-1');
    hold();

    assert.deepEqual(await releasing, { released: 1 });
    assert.deepEqual(await reallocating, { started: 2 });
    assert.deepEqual(driver.calls.reused, []);
  });

  test('a release whose stop failed leaves the next allocation reusing the same session', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    await table.allocate({ leaseId: 'lease-1' }, 'lease-1');
    driver.failNextStop(new Error('delete refused'));
    const releasing = table.release({ leaseId: 'lease-1' }, 'lease-1');

    await assert.rejects(
      () => releasing,
      (error: unknown) =>
        rejectionReason(error) === 'provider-stop-unconfirmed' &&
        causeMessage(error) === 'delete refused',
    );
    assert.deepEqual(await table.allocate({ leaseId: 'lease-1' }, 'lease-1'), { reused: 1 });
    assert.deepEqual(driver.calls.starts, ['lease-1']);
  });

  test('a release with no session of its own ends what the provider search finds', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    driver.reportSearch({ status: 'found', lease: { instanceIds: ['instance-1', 'instance-2'] } });

    assert.deepEqual(await table.release({ leaseId: 'lease-9' }, 'lease-9'), { instanceCount: 2 });
    assert.deepEqual(driver.calls.searches, ['lease-9']);
    assert.deepEqual(driver.calls.recovered, [{ instanceIds: ['instance-1', 'instance-2'] }]);
  });

  test('two releases of one lease the runtime never started search for it once', async () => {
    const driver = fakeDriver();
    driver.reportSearch({ status: 'found', lease: { instanceIds: ['instance-1'] } });
    const table = createProviderLeaseSessionTable(driver);

    await Promise.all([
      table.release({ leaseId: 'lease-9' }, 'lease-9'),
      table.release({ leaseId: 'lease-9' }, 'lease-9'),
    ]);

    assert.deepEqual(driver.calls.searches, ['lease-9']);
    assert.deepEqual(driver.calls.recovered, [{ instanceIds: ['instance-1'] }]);
  });

  test('a provider that has no session for the lease releases it without a stop', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    driver.reportSearch({ status: 'absent' });

    assert.equal(await table.release({ leaseId: 'lease-9' }, 'lease-9'), undefined);
    assert.deepEqual(driver.calls.recovered, []);
  });

  test('a search that cannot answer keeps the lease pending instead of reporting it released', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    driver.reportSearch({ status: 'unknown', cause: new Error('list timed out') });

    await assert.rejects(
      () => table.release({ leaseId: 'lease-9' }, 'lease-9'),
      (error: unknown) =>
        rejectionReason(error) === 'provider-lease-search-unanswered' &&
        causeMessage(error) === 'list timed out',
    );
    assert.deepEqual(driver.calls.recovered, []);
  });

  test('a search that raises keeps the lease pending as the same answer does', async () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable({
      ...driver,
      searchLease: async (request) => {
        driver.calls.searches.push(request.leaseId);
        throw new Error('list refused');
      },
    });

    await assert.rejects(
      () => table.release({ leaseId: 'lease-9' }, 'lease-9'),
      (error: unknown) =>
        rejectionReason(error) === 'provider-lease-search-unanswered' &&
        causeMessage(error) === 'list refused',
    );
  });

  test('a provider that cannot stop what it found reports it instead of losing the lease', async () => {
    const driver = fakeDriver();
    driver.reportSearch({ status: 'found', lease: { instanceIds: ['instance-1'] } });
    const table = createProviderLeaseSessionTable({ ...driver, stopLease: async () => undefined });

    await assert.rejects(
      () => table.release({ leaseId: 'lease-9' }, 'lease-9'),
      (error: unknown) => rejectionReason(error) === 'provider-lease-not-releasable',
    );
  });

  test('a stop of what the search found that did not confirm keeps the lease pending', async () => {
    const driver = fakeDriver();
    driver.reportSearch({ status: 'found', lease: { instanceIds: ['instance-1'] } });
    const refused = new Error('delete refused');
    const table = createProviderLeaseSessionTable({
      ...driver,
      stopLease: async () => ({ stopped: false as const, cause: refused }),
    });

    await assert.rejects(
      () => table.release({ leaseId: 'lease-9' }, 'lease-9'),
      (error: unknown) =>
        rejectionReason(error) === 'provider-stop-unconfirmed' &&
        causeMessage(error) === refused.message,
    );
  });

  test('every failure that can leave a device rented is cleanup still pending', () => {
    const pending: readonly ProviderLeaseRejection[] = [
      { reason: 'provider-stop-unconfirmed', leaseId: 'l', cause: new Error('refused') },
      { reason: 'provider-drain-unconfirmed', leaseIds: ['l'] },
      { reason: 'provider-lease-search-unanswered', leaseId: 'l', cause: new Error('timed out') },
      { reason: 'provider-lease-not-releasable', leaseId: 'l' },
    ];
    for (const rejection of pending) {
      assert.equal(providerLeaseFailureReason(rejection), 'provider-cleanup-pending');
    }
    assert.equal(
      providerLeaseFailureReason({ reason: 'provider-runtime-shutting-down' }),
      'provider-runtime-shutting-down',
    );
    assert.equal(
      providerLeaseFailureReason({ reason: 'provider-allocation-cancelled', leaseId: 'l' }),
      'provider-allocation-cancelled',
    );
    assert.equal(
      providerLeaseFailureReason({
        reason: 'provider-start-deadline-exceeded',
        leaseId: 'l',
        deadlineAt: 1,
      }),
      'provider-start-deadline-exceeded',
    );
  });

  test('the reason the driver builds an error from is the shared one, not the rejection name', () => {
    const driver = fakeDriver();
    const table = createProviderLeaseSessionTable(driver);
    return table.allocate({ leaseId: 'lease-1' }, 'lease-1', { deadlineAt: -1 }).then(
      () => assert.fail('expected the deadline to be exceeded'),
      (error: unknown) => {
        assert.equal(reported(error).reason, 'provider-start-deadline-exceeded');
      },
    );
  });
});
