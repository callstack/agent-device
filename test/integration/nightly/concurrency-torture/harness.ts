// Seeded concurrency torture harness for session / lease / lock invariants (#1416).
//
// N logical clients drive randomized-but-seeded programs of
// open / mutate / close / takeover / kill against the REAL invariant-bearing
// daemon modules — `SessionStore` and `LeaseRegistry` — plus an in-memory model
// of the enforced device claim. All concurrency is routed through the
// `DeterministicScheduler`, so a seed fully determines the interleaving and any
// failure replays exactly (see docs/agents/testing.md).
//
// What is real vs modeled (issue review amendment "say which and why"):
//   - REAL: `SessionStore` (session map/consistency) and `LeaseRegistry` (lease
//     allocation, per-device exclusivity, release, scope checks).
//   - REAL lock PLAN: every operation's lock keys come from the production
//     router primitive `resolveRequestExecutionLockKeys` (see bindings.ts),
//     driven with a fake device inventory. Only the mutex GRANT is modeled by
//     the scheduler, because `withKeyedLock`'s native microtask hand-off cannot
//     be reproduced from a seed. Reverting the router's same-device
//     serialization therefore changes the derived plan and trips the overlap
//     invariant. `withKeyedLock` reentrancy/cleanup stay covered by unit tests.
//   - MODELED: the enforced device claim (`InMemoryClaimRegistry`) and process
//     "kill"; the production claim is a filesystem/OS lock and real process
//     death, both out of scope for this scheduling-torture lane.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DeviceInfo } from '@agent-device/kernel/device';
import { LeaseRegistry } from '../../../../src/daemon/lease-registry.ts';
import { SessionStore } from '../../../../src/daemon/session-store.ts';
import type { SessionState } from '../../../../src/daemon/types.ts';
import { AppError } from '@agent-device/kernel/errors';

import { makePrng, type Prng } from './prng.ts';
import {
  DeterministicScheduler,
  SchedulerDeadlockError,
  serializeTrace,
  type Fiber,
  type LockKey,
} from './deterministic-scheduler.ts';
import { InMemoryClaimRegistry } from './claim-registry.ts';
import {
  CLOSE_COMMAND,
  DEVICE_POOL,
  MUTATE_COMMAND,
  deviceClaimKey,
  resolveExistingLockPlan,
  resolveOpenLockPlan,
  type LeaseScope,
  type SessionInstance,
} from './bindings.ts';
import { checkInvariants, type InvariantFailure } from './invariants.ts';

export type ClientOp = 'open' | 'mutate' | 'close' | 'takeover' | 'kill';

const ALL_OPS: readonly ClientOp[] = ['open', 'mutate', 'close', 'takeover', 'kill'];

export type TortureConfig = {
  seed: number;
  clients?: number;
  opsPerClient?: number;
  // Deterministic overrides used by the forced same-device contention test.
  program?: ClientOp[][];
  pinnedDevice?: DeviceInfo;
};

export type TortureRunResult = {
  seed: number;
  clients: number;
  ops: number;
  scheduleLength: number;
  perDeviceMaxConcurrency: Record<string, number>;
  // Number of device-lock acquisitions that had to park on a held lock, i.e.
  // genuine same-device contention that actually occurred this run.
  deviceContention: number;
  // Canonical serialization of the full scheduler decision trace, for exact
  // replay comparison (equal seed ⇒ equal signature).
  traceSignature: string;
  failures: InvariantFailure[];
};

export async function runTorture(config: TortureConfig): Promise<TortureRunResult> {
  const world = new TortureWorld(config);
  return await world.run();
}

class TortureWorld {
  private readonly prng: Prng;
  private readonly scheduler: DeterministicScheduler;
  private readonly sessionStore: SessionStore;
  private readonly leaseRegistry: LeaseRegistry;
  private readonly claims = new InMemoryClaimRegistry();
  private readonly stateRoot: string;

  private readonly clientCount: number;
  private readonly opsPerClient: number;

  // Shadow bookkeeping.
  private readonly instances = new Map<number, SessionInstance>();
  private readonly deviceOwner = new Map<string, number>();
  private readonly clientInstance = new Map<number, number | undefined>();
  private nextInstanceId = 0;
  // Every open gets a UNIQUE session name. Production keys a session by name, so
  // reusing a name across opens (e.g. kill then re-open on another device) would
  // let the store's device for that name diverge from the shadow instance's,
  // making the router derive a lock plan for the wrong device. Unique names keep
  // store and shadow in lockstep — exactly one device per session name.
  private nextSessionSeq = 0;
  private activeClients: number;

  // Serialization instrumentation: concurrent critical sections per device.
  private readonly deviceActive = new Map<string, number>();
  private readonly deviceMaxActive = new Map<string, number>();

  // Invariant violations detected mid-run (vs. the post-run structural checks).
  private readonly runtimeFailures: InvariantFailure[] = [];

  private readonly config: TortureConfig;

  constructor(config: TortureConfig) {
    this.config = config;
    this.prng = makePrng(config.seed);
    this.scheduler = new DeterministicScheduler((bound) => this.prng.int(bound));
    this.clientCount = config.program?.length ?? config.clients ?? 2 + this.prng.int(4); // 2..5
    this.opsPerClient = config.opsPerClient ?? 6 + this.prng.int(9); // 6..14
    this.activeClients = this.clientCount;
    this.stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-torture-'));
    this.sessionStore = new SessionStore(path.join(this.stateRoot, 'sessions'));
    this.leaseRegistry = new LeaseRegistry({ maxLeaseTtlMs: 10 * 60_000 });
  }

  async run(): Promise<TortureRunResult> {
    const programs = this.buildPrograms();
    const fibers = programs.map((ops, client) => ({
      name: `client-${client}`,
      body: (fiber: Fiber) => this.runClient(fiber, client, ops),
    }));
    fibers.push({ name: 'reaper', body: (fiber: Fiber) => this.runReaper(fiber) });

    const failures: InvariantFailure[] = [];
    try {
      await this.scheduler.run(fibers);
    } catch (error) {
      if (error instanceof SchedulerDeadlockError) {
        failures.push({ invariant: 'no deadlock', detail: error.message });
      } else {
        throw error;
      }
    }

    failures.push(...this.runtimeFailures);
    failures.push(
      ...checkInvariants({
        sessionStore: this.sessionStore,
        leaseRegistry: this.leaseRegistry,
        claimSnapshot: this.claims.snapshot(),
        claimOwner: (deviceKey) => this.claims.ownerSession(deviceKey),
        instances: [...this.instances.values()],
        isInstanceLive: (instance) => this.isInstanceLive(instance),
        deviceActive: this.deviceActive,
        deviceMaxActive: this.deviceMaxActive,
        assertQuiescent: () => this.scheduler.assertQuiescent(),
      }),
    );
    this.cleanup();

    return {
      seed: this.config.seed,
      clients: this.clientCount,
      ops: this.opsPerClient * this.clientCount,
      scheduleLength: this.scheduler.trace.length,
      perDeviceMaxConcurrency: Object.fromEntries(this.deviceMaxActive),
      deviceContention: this.deviceContentionTotal(),
      traceSignature: serializeTrace(this.scheduler.trace),
      failures,
    };
  }

  private deviceContentionTotal(): number {
    let total = 0;
    for (const [key, count] of this.scheduler.contentionByKey) {
      if (key.startsWith('device:')) total += count;
    }
    return total;
  }

  // --- program generation -------------------------------------------------

  private buildPrograms(): ClientOp[][] {
    if (this.config.program) return this.config.program.map((ops) => [...ops]);
    return Array.from({ length: this.clientCount }, () => {
      const ops: ClientOp[] = [];
      for (let i = 0; i < this.opsPerClient; i += 1) {
        ops.push(this.prng.pick(ALL_OPS));
      }
      return ops;
    });
  }

  // --- client fiber -------------------------------------------------------

  private async runClient(fiber: Fiber, client: number, ops: ClientOp[]): Promise<void> {
    this.clientInstance.set(client, undefined);
    try {
      for (const op of ops) {
        await fiber.step(`client-${client}:${op}`);
        await this.dispatch(fiber, client, op);
      }
    } finally {
      this.activeClients -= 1;
    }
  }

  private async dispatch(fiber: Fiber, client: number, op: ClientOp): Promise<void> {
    switch (op) {
      case 'open':
        return await this.doOpen(fiber, client, false);
      case 'takeover':
        return await this.doOpen(fiber, client, true);
      case 'mutate':
        return await this.doMutate(fiber, client);
      case 'close':
        return await this.doClose(fiber, client);
      case 'kill':
        return await this.doKill(fiber, client);
    }
  }

  /**
   * Acquire a production-derived lock plan in order, yielding a scheduling point
   * after each grant, then run `body` inside the innermost critical section.
   */
  private async withLockPlan(
    fiber: Fiber,
    plan: readonly LockKey[],
    label: string,
    body: () => Promise<void>,
  ): Promise<void> {
    const acquireFrom = async (index: number): Promise<void> => {
      if (index >= plan.length) return await body();
      const key = plan[index] as LockKey;
      await fiber.withLock(key, async () => {
        await fiber.step(`${label}-locked:${key}`);
        await acquireFrom(index + 1);
      });
    };
    await acquireFrom(0);
  }

  private async doOpen(fiber: Fiber, client: number, takeover: boolean): Promise<void> {
    if (this.liveInstanceOf(client)) return; // already managing a session
    const device = this.config.pinnedDevice ?? this.prng.pick(DEVICE_POOL);
    const name = `s${client}-${this.nextSessionSeq++}`;
    const plan = await resolveOpenLockPlan(this.sessionStore, name, device);
    await this.withLockPlan(fiber, plan, `open-${client}`, async () => {
      await this.enterDeviceCritical(fiber, device.id);
      try {
        const current = this.deviceOwner.get(device.id);
        if (current !== undefined) {
          const owner = this.instances.get(current);
          if (owner && !owner.reaped) {
            if (takeover || owner.dead) {
              this.reapInstance(owner);
            } else {
              return; // device busy with a live owner; open is a no-op
            }
          }
        }
        this.openSession(client, name, device);
      } finally {
        this.exitDeviceCritical(device.id);
      }
    });
  }

  private async doMutate(fiber: Fiber, client: number): Promise<void> {
    const instance = this.liveInstanceOf(client);
    if (!instance) return;
    const plan = await resolveExistingLockPlan(this.sessionStore, instance.name, MUTATE_COMMAND);
    await this.withLockPlan(fiber, plan, `mutate-${client}`, async () => {
      await this.enterDeviceCritical(fiber, instance.deviceId);
      try {
        if (!this.isInstanceLive(instance)) return; // evicted/reaped meanwhile
        // Heartbeat through the real registry: identity must be preserved and
        // must not resolve to a different session's lease (cross-session bleed).
        const refreshed = this.leaseRegistry.heartbeatLease({
          leaseId: instance.lease.leaseId,
          tenantId: instance.lease.tenantId,
          runId: instance.lease.runId,
          leaseBackend: instance.lease.leaseBackend,
          deviceKey: instance.lease.deviceKey,
          clientId: instance.lease.clientId,
        });
        if (refreshed.leaseId !== instance.lease.leaseId) {
          this.fail(
            'no cross-session bleed',
            `heartbeat returned foreign lease ${refreshed.leaseId}`,
          );
        }
        instance.mutations += 1;
      } finally {
        this.exitDeviceCritical(instance.deviceId);
      }
    });
  }

  private fail(invariant: string, detail: string): void {
    this.runtimeFailures.push({ invariant, detail });
  }

  private async doClose(fiber: Fiber, client: number): Promise<void> {
    const instance = this.liveInstanceOf(client);
    if (!instance) return;
    const plan = await resolveExistingLockPlan(this.sessionStore, instance.name, CLOSE_COMMAND);
    await this.withLockPlan(fiber, plan, `close-${client}`, async () => {
      await this.enterDeviceCritical(fiber, instance.deviceId);
      try {
        if (this.isInstanceLive(instance)) this.reapInstance(instance);
        this.clientInstance.set(client, undefined);
      } finally {
        this.exitDeviceCritical(instance.deviceId);
      }
    });
  }

  private async doKill(fiber: Fiber, client: number): Promise<void> {
    const instance = this.liveInstanceOf(client);
    if (!instance) return;
    // Owner death: the client forgets its session WITHOUT releasing anything.
    // The lease/claim/store entry become an orphan that only the reaper (or a
    // takeover) may reclaim — the "every lock released after owner death" case.
    await fiber.step(`kill:${client}`);
    instance.dead = true;
    this.clientInstance.set(client, undefined);
  }

  // --- reaper fiber -------------------------------------------------------

  private async runReaper(fiber: Fiber): Promise<void> {
    for (;;) {
      await fiber.step('reaper');
      const orphan = this.findOrphan();
      if (!orphan) {
        if (this.activeClients <= 0 && !this.findOrphan()) return;
        continue;
      }
      const plan = await resolveExistingLockPlan(this.sessionStore, orphan.name, CLOSE_COMMAND);
      await this.withLockPlan(fiber, plan, 'reaper', async () => {
        await this.enterDeviceCritical(fiber, orphan.deviceId);
        try {
          if (this.isInstanceLive(orphan) && orphan.dead) this.reapInstance(orphan);
        } finally {
          this.exitDeviceCritical(orphan.deviceId);
        }
      });
    }
  }

  private findOrphan(): SessionInstance | undefined {
    for (const instance of this.instances.values()) {
      if (instance.dead && !instance.reaped) return instance;
    }
    return undefined;
  }

  // --- state transitions (all under the appropriate locks) ----------------

  private openSession(client: number, name: string, device: DeviceInfo): void {
    const deviceKey = deviceClaimKey(device);
    const lease = this.leaseRegistry.allocateLease({
      tenantId: `t${client}`,
      runId: `r${client}`,
      leaseBackend: 'ios-simulator',
      deviceKey,
      clientId: `c${client}`,
    });
    const claimResult = this.claims.acquire(deviceKey, name);
    if (!claimResult.ownership) {
      // A live claim under a held device lock means the store/claim disagreed.
      this.fail('session store consistent', `claim conflict opening ${name} on ${device.id}`);
      this.releaseLease(lease.leaseId, client, deviceKey);
      return;
    }
    const leaseScope: LeaseScope = {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: 'ios-simulator',
      deviceKey,
      clientId: `c${client}`,
    };
    const state: SessionState = {
      name,
      device,
      createdAt: Date.now(),
      actions: [],
      lease: { ...leaseScope, expiresAt: lease.expiresAt },
      deviceClaim: {
        deviceKey,
        ownerToken: claimResult.ownership.ownerToken,
        ownerPid: process.pid,
        ownerStartTime: null,
      },
    };
    this.sessionStore.set(name, state);
    const instanceId = this.nextInstanceId++;
    const instance: SessionInstance = {
      instanceId,
      name,
      deviceId: device.id,
      deviceKey,
      lease: leaseScope,
      claim: claimResult.ownership,
      ownerClient: client,
      dead: false,
      reaped: false,
      mutations: 0,
    };
    this.instances.set(instanceId, instance);
    this.deviceOwner.set(device.id, instanceId);
    this.clientInstance.set(client, instanceId);
  }

  private releaseLease(leaseId: string, client: number, deviceKey: string): void {
    this.leaseRegistry.releaseLease({
      leaseId,
      tenantId: `t${client}`,
      runId: `r${client}`,
      leaseBackend: 'ios-simulator',
      deviceKey,
      clientId: `c${client}`,
    });
  }

  private reapInstance(instance: SessionInstance): void {
    if (instance.reaped) return;
    try {
      this.leaseRegistry.releaseLease({
        leaseId: instance.lease.leaseId,
        tenantId: instance.lease.tenantId,
        runId: instance.lease.runId,
        leaseBackend: instance.lease.leaseBackend,
        deviceKey: instance.lease.deviceKey,
        clientId: instance.lease.clientId,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      this.fail('no leaked leases', `release threw for ${instance.name}: ${error.message}`);
    }
    this.claims.clear(instance.claim);
    const stored = this.sessionStore.get(instance.name);
    if (stored?.lease?.leaseId === instance.lease.leaseId) {
      this.sessionStore.delete(instance.name);
    }
    instance.reaped = true;
    if (this.deviceOwner.get(instance.deviceId) === instance.instanceId) {
      this.deviceOwner.delete(instance.deviceId);
    }
    if (this.clientInstance.get(instance.ownerClient) === instance.instanceId) {
      this.clientInstance.set(instance.ownerClient, undefined);
    }
  }

  private isInstanceLive(instance: SessionInstance): boolean {
    return !instance.reaped && this.deviceOwner.get(instance.deviceId) === instance.instanceId;
  }

  private liveInstanceOf(client: number): SessionInstance | undefined {
    const id = this.clientInstance.get(client);
    if (id === undefined) return undefined;
    const instance = this.instances.get(id);
    return instance && this.isInstanceLive(instance) ? instance : undefined;
  }

  // --- serialization instrumentation --------------------------------------

  private async enterDeviceCritical(fiber: Fiber, deviceId: string): Promise<void> {
    const active = (this.deviceActive.get(deviceId) ?? 0) + 1;
    this.deviceActive.set(deviceId, active);
    this.deviceMaxActive.set(deviceId, Math.max(active, this.deviceMaxActive.get(deviceId) ?? 0));
    // Yield WHILE inside the device critical section: if same-device
    // serialization were broken, another fiber would interleave here and push
    // the active count above 1.
    await fiber.step(`device-critical:${deviceId}`);
  }

  private exitDeviceCritical(deviceId: string): void {
    this.deviceActive.set(deviceId, (this.deviceActive.get(deviceId) ?? 1) - 1);
  }

  private cleanup(): void {
    try {
      fs.rmSync(this.stateRoot, { recursive: true, force: true });
    } catch {
      // Best effort; a leftover temp dir never fails the invariant check.
    }
  }
}
