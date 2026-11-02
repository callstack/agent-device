import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createProviderLeaseTable, type ProviderLeaseStart } from './provider-lease-table.ts';

type Handle = Readonly<{ id: string }>;
type Session = Readonly<{ id: string }>;
type Pending<T> = { resolve(value: T): void; reject(error: unknown): void };

/** A seeded generator, so a failing seed replays the same interleaving. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const LEASES = ['lease-a', 'lease-b'];
/** A lease whose device a previous daemon left rented; this process owns it once it recovers it. */
const INHERITED = 'lease-c';

function lease(leaseId: string): DeviceLease {
  const base = { tenantId: 't', runId: 'r', createdAt: 0, heartbeatAt: 0 };
  return { ...base, leaseId, backend: 'ios-instance', expiresAt: Number.MAX_SAFE_INTEGER };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * One seeded run: allocations, aborts, releases, recoveries, one shutdown, and time passing, issued in
 * seeded bursts so some land in the same tick, with every start and stop answered in a seeded order.
 * The provider side records which devices are rented, and which of them this table took on.
 */
async function run(seed: number): Promise<void> {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)];
  const rented = new Set<string>([`${INHERITED}#0`]);
  const owned = new Set<string>();
  const lastDevice = new Map<string, string>([[INHERITED, `${INHERITED}#0`]]);
  const starts: Array<Pending<ProviderLeaseStart<Session, Handle>> & { id: string }> = [];
  const stops: Array<Pending<void>> = [];
  const stopsInFlight = new Map<string, number>();
  const controllers: AbortController[] = [];
  let confirmEveryStop = false;
  let devices = 0;
  // Recorded rather than thrown: a throw inside a provider callback would read as a provider failure.
  const violations: string[] = [];
  const fail = (message: string): void => {
    violations.push(message);
  };
  const stillRented = (): string[] => [...owned].filter((id) => rented.has(id));
  const table = createProviderLeaseTable<Session, Handle, unknown>({
    startTimeoutMs: 50,
    stopTimeoutMs: 20,
    start: async (target, _request, control) =>
      await new Promise((resolve, reject) => {
        const id = `${target.leaseId}#${(devices += 1)}`;
        lastDevice.set(target.leaseId, id);
        starts.push({ id, resolve, reject });
        // Some starts publish their device before they answer, as a provider that names it early does.
        if (next() < 0.3) {
          rented.add(id);
          owned.add(id);
          control.rented({ id });
        }
      }),
    stop: async ({ id }) => {
      const inFlight = (stopsInFlight.get(id) ?? 0) + 1;
      if (inFlight > 1) fail(`two stops of ${id} in flight`);
      stopsInFlight.set(id, inFlight);
      try {
        if (!confirmEveryStop) {
          await new Promise<void>((resolve, reject) => stops.push({ resolve, reject }));
        }
        rented.delete(id);
      } finally {
        stopsInFlight.set(id, inFlight - 1);
      }
    },
    handleKey: ({ id }) => id,
    findByLease: async (target) => {
      const id = lastDevice.get(target.leaseId) ?? `${target.leaseId}#0`;
      owned.add(id);
      return { id };
    },
    shuttingDown: () => new Error('shutting down'),
    releasing: () => new Error('releasing'),
    gaveUp: () => new Error('gave up'),
    cleanupPending: (unconfirmed) =>
      Object.assign(new Error('pending'), {
        ids: unconfirmed.map((stop) => stop.handle?.id),
        unnamed: unconfirmed.flatMap((stop) => (stop.handle ? [] : [stop.leaseId])),
      }),
  });

  const allocate = (leaseId: string): void => {
    const controller = new AbortController();
    controllers.push(controller);
    void table.allocate(lease(leaseId), {}, { signal: controller.signal }).then(
      (session) => {
        // Delivered only while the lease serves it, and only for a device still rented.
        if (table.live(leaseId) !== session) fail(`${session.id} handed out after its lease ended`);
        if (!rented.has(session.id)) fail(`${session.id} handed out after its device stopped`);
      },
      () => undefined,
    );
  };
  const answerStart = (): void => {
    const start = starts.splice(Math.floor(next() * starts.length), 1)[0];
    if (start === undefined) return;
    const kind = next();
    const handle = { id: start.id };
    // A device the start already published is the one the answer names; it is not rented twice.
    if (kind < 0.85 && !owned.has(start.id)) {
      rented.add(start.id);
      owned.add(start.id);
    }
    if (kind < 0.55) start.resolve({ status: 'ready', session: handle, handle });
    else if (kind < 0.7) start.resolve({ status: 'failed', error: new Error('x'), rented: handle });
    else if (kind < 0.85) start.reject(new Error('lost answer'));
    else start.resolve({ status: 'failed', error: new Error('refused') });
  };
  const answerStop = (): void => {
    const stop = stops.splice(Math.floor(next() * stops.length), 1)[0];
    if (stop === undefined) return;
    if (next() < 0.7) stop.resolve();
    else stop.reject(new Error('stop refused'));
  };
  let shutdownCalled = false;
  const shutdown = (): void => {
    shutdownCalled = true;
    void table.shutdown().then(
      () => {
        if (stillRented().length > 0) fail(`shutdown resolved with ${stillRented().join(', ')}`);
      },
      (error: { ids?: string[]; unnamed?: string[] }) => {
        // A device is reported by its id, or by its lease when the report could not name it yet.
        for (const id of stillRented()) {
          const leaseId = id.split('#')[0]!;
          if (!error.ids?.includes(id) && !error.unnamed?.includes(leaseId)) {
            fail(`shutdown left ${id} rented and unreported`);
          }
        }
      },
    );
  };
  const act = (): void => {
    const roll = next();
    const leaseId = pick(LEASES)!;
    if (roll < 0.2 && !shutdownCalled) allocate(leaseId);
    else if (roll < 0.24) void table.recover(lease(INHERITED)).catch(() => undefined);
    else if (roll < 0.3) vi.advanceTimersByTime(Math.floor(next() * 60));
    else if (roll < 0.36) pick(controllers)?.abort();
    else if (roll < 0.43) void table.release(leaseId).catch(() => undefined);
    else if (roll < 0.48) void table.recover(lease(leaseId)).catch(() => undefined);
    else if (roll < 0.51 && !shutdownCalled) shutdown();
    else if (roll < 0.76) answerStart();
    else answerStop();
  };

  for (let step = 0; step < 40; step += 1) {
    const burst = 1 + Math.floor(next() * 3);
    for (let op = 0; op < burst; op += 1) act();
    await settle();
  }
  // Every start answers and every stop confirms from here on, so a failed stop must still be retried.
  confirmEveryStop = true;
  while (starts.length > 0 || stops.length > 0) {
    starts
      .splice(0)
      .forEach((start) => start.resolve({ status: 'failed', error: new Error('late') }));
    stops.splice(0).forEach((stop) => stop.resolve());
    vi.advanceTimersByTime(100);
    await settle();
  }
  await table.shutdown().catch(() => undefined);
  await table.shutdown();
  assert.deepEqual(violations, [], `seed ${seed}`);
  assert.deepEqual(stillRented(), [], `seed ${seed}: devices left rented after the final drain`);
}

test('seeded interleavings keep every lease-table invariant', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    for (let seed = 0; seed < 400; seed += 1) await run(seed);
  } finally {
    vi.useRealTimers();
  }
});
