// Seeded concurrency torture harness for session / lease / lock invariants (#1416).
//
// N logical clients drive randomized-but-seeded programs of
// open / mutate / close / takeover / kill against the REAL invariant-bearing
// daemon modules — `SessionStore` and `LeaseRegistry` — plus an in-memory model
// of the advisory device claim. All concurrency is routed through the
// `DeterministicScheduler`, so a seed fully determines the interleaving and any
// failure replays exactly (see docs/agents/testing.md).
//
// What is real vs modeled (issue review amendment "say which and why"):
//   - REAL: `SessionStore` (session map/consistency) and `LeaseRegistry` (lease
//     allocation, per-device exclusivity, release, scope checks).
//   - REAL rule, modeled mechanism: same-device serialization. The production
//     router serializes on `RequestExecutionLockKey`s via `withKeyedLock`
//     (`src/daemon/request-binding.ts` + `request-execution-scope.ts`). We reuse
//     the exact key shape and lock ORDER (session before device) but grant the
//     locks through the scheduler mutex, because a seed cannot reproduce Node's
//     native microtask hand-off inside `withKeyedLock`. The invariant under test
//     — critical sections for one device never overlap; serialization is total —
//     is identical, and now seed-deterministic. `withKeyedLock` reentrancy and
//     cleanup remain covered by their own unit tests.
//   - MODELED: the advisory device claim (`InMemoryClaimRegistry`) and process
//     "kill"; the production claim is a filesystem/OS lock and real process
//     death, both out of scope for this scheduling-torture lane.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DeviceInfo } from '../../../src/kernel/device.ts';
import { LeaseRegistry } from '../../../src/daemon/lease-registry.ts';
import { SessionStore } from '../../../src/daemon/session-store.ts';
import type { SessionState } from '../../../src/daemon/types.ts';
import { AppError } from '../../../src/kernel/errors.ts';

import { makePrng, type Prng } from './prng.ts';
import {
  DeterministicScheduler,
  SchedulerDeadlockError,
  type Fiber,
  type LockKey,
} from './deterministic-scheduler.ts';
import { InMemoryClaimRegistry, type AdvisoryClaimOwnership } from './claim-registry.ts';

const DEVICE_POOL: readonly DeviceInfo[] = [
  {
    platform: 'apple',
    id: 'sim-a',
    name: 'iPhone A',
    kind: 'simulator',
    appleOs: 'ios',
    booted: true,
  },
  {
    platform: 'apple',
    id: 'sim-b',
    name: 'iPhone B',
    kind: 'simulator',
    appleOs: 'ios',
    booted: true,
  },
  { platform: 'android', id: 'emu-c', name: 'Pixel C', kind: 'emulator', booted: true },
];

type ClientOp = 'open' | 'mutate' | 'close' | 'takeover' | 'kill';

const ALL_OPS: readonly ClientOp[] = ['open', 'mutate', 'close', 'takeover', 'kill'];

/**
 * The lease scope for one opened session, kept so the harness can release it
 * through the real `LeaseRegistry` with a matching owner scope.
 */
type LeaseScope = {
  leaseId: string;
  tenantId: string;
  runId: string;
  leaseBackend: 'ios-simulator';
  deviceKey: string;
  clientId: string;
};

/**
 * Shadow record of one session instance the harness opened. `instanceId` is
 * unique across the whole run even when a session NAME is reused, so a stale
 * reference can never be mistaken for a live one.
 */
type SessionInstance = {
  instanceId: number;
  name: string;
  deviceId: string;
  deviceKey: string;
  lease: LeaseScope;
  claim: AdvisoryClaimOwnership;
  ownerClient: number;
  dead: boolean;
  reaped: boolean;
  mutations: number;
};

export type TortureConfig = {
  seed: number;
  clients?: number;
  opsPerClient?: number;
};

export type InvariantFailure = {
  invariant: string;
  detail: string;
};

export type TortureRunResult = {
  seed: number;
  clients: number;
  ops: number;
  scheduleLength: number;
  perDeviceMaxConcurrency: Record<string, number>;
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
  // Which live instance currently owns a device id (harness's expectation).
  private readonly deviceOwner = new Map<string, number>();
  // Each client's currently-managed instance id, or undefined when not open.
  private readonly clientInstance = new Map<number, number | undefined>();
  private nextInstanceId = 0;
  private activeClients: number;

  // Serialization instrumentation: concurrent critical sections per device.
  private readonly deviceActive = new Map<string, number>();
  private readonly deviceMaxActive = new Map<string, number>();

  private readonly failures: InvariantFailure[] = [];

  constructor(config: TortureConfig) {
    this.prng = makePrng(config.seed);
    this.scheduler = new DeterministicScheduler((bound) => this.prng.int(bound));
    this.clientCount = config.clients ?? 2 + this.prng.int(4); // 2..5
    this.opsPerClient = config.opsPerClient ?? 6 + this.prng.int(9); // 6..14
    this.activeClients = this.clientCount;
    this.stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-torture-'));
    this.sessionStore = new SessionStore(path.join(this.stateRoot, 'sessions'));
    this.leaseRegistry = new LeaseRegistry({ maxLeaseTtlMs: 10 * 60_000 });
    this.config = config;
  }

  private readonly config: TortureConfig;

  async run(): Promise<TortureRunResult> {
    const programs = this.buildPrograms();
    const fibers = programs.map((ops, client) => ({
      name: `client-${client}`,
      body: (fiber: Fiber) => this.runClient(fiber, client, ops),
    }));
    fibers.push({ name: 'reaper', body: (fiber: Fiber) => this.runReaper(fiber) });

    try {
      await this.scheduler.run(fibers);
    } catch (error) {
      if (error instanceof SchedulerDeadlockError) {
        this.failures.push({ invariant: 'no deadlock', detail: error.message });
      } else {
        throw error;
      }
    }

    this.checkInvariants();
    this.cleanup();

    return {
      seed: this.config.seed,
      clients: this.clientCount,
      ops: this.opsPerClient * this.clientCount,
      scheduleLength: this.scheduler.trace.length,
      perDeviceMaxConcurrency: Object.fromEntries(this.deviceMaxActive),
      failures: this.failures,
    };
  }

  // --- program generation -------------------------------------------------

  private buildPrograms(): ClientOp[][] {
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

  private async doOpen(fiber: Fiber, client: number, takeover: boolean): Promise<void> {
    if (this.liveInstanceOf(client)) return; // already managing a session
    const device = this.prng.pick(DEVICE_POOL);
    const name = `sess-${client}`;
    await fiber.withLock(this.sessionKey(name), async () => {
      await fiber.step(`open-session-locked:${client}`);
      await fiber.withLock(this.deviceKey(device.id), async () => {
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
    });
  }

  private async doMutate(fiber: Fiber, client: number): Promise<void> {
    const instance = this.liveInstanceOf(client);
    if (!instance) return;
    await fiber.withLock(this.sessionKey(instance.name), async () => {
      await fiber.step(`mutate-session-locked:${client}`);
      await fiber.withLock(this.deviceKey(instance.deviceId), async () => {
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
    });
  }

  private async doClose(fiber: Fiber, client: number): Promise<void> {
    const instance = this.liveInstanceOf(client);
    if (!instance) return;
    await fiber.withLock(this.sessionKey(instance.name), async () => {
      await fiber.step(`close-session-locked:${client}`);
      await fiber.withLock(this.deviceKey(instance.deviceId), async () => {
        await this.enterDeviceCritical(fiber, instance.deviceId);
        try {
          if (this.isInstanceLive(instance)) this.reapInstance(instance);
          this.clientInstance.set(client, undefined);
        } finally {
          this.exitDeviceCritical(instance.deviceId);
        }
      });
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
      await fiber.withLock(this.sessionKey(orphan.name), async () => {
        await fiber.step('reaper-session-locked');
        await fiber.withLock(this.deviceKey(orphan.deviceId), async () => {
          await this.enterDeviceCritical(fiber, orphan.deviceId);
          try {
            if (this.isInstanceLive(orphan) && orphan.dead) this.reapInstance(orphan);
          } finally {
            this.exitDeviceCritical(orphan.deviceId);
          }
        });
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
    const deviceKey = `local:${device.platform}:${device.appleOs ?? 'none'}:${device.id}`;
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
      this.leaseRegistry.releaseLease({
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: 'ios-simulator',
        deviceKey,
        clientId: `c${client}`,
      });
      return;
    }
    const instanceId = this.nextInstanceId++;
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
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: 'ios-simulator',
        deviceKey,
        clientId: `c${client}`,
        expiresAt: lease.expiresAt,
      },
      deviceClaim: {
        deviceKey,
        ownerToken: claimResult.ownership.ownerToken,
        ownerPid: process.pid,
        ownerStartTime: null,
      },
    };
    this.sessionStore.set(name, state);
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

  // --- lock keys ----------------------------------------------------------

  private sessionKey(name: string): LockKey {
    return `session:${name}`;
  }

  private deviceKey(deviceId: string): LockKey {
    return `device:${deviceId}`;
  }

  // --- invariants ---------------------------------------------------------

  private checkInvariants(): void {
    this.checkSerialization();
    this.checkLocksReleased();
    this.checkStoreConsistency();
    this.checkNoLeakedLeases();
    this.checkNoLeakedClaims();
    this.checkNoCrossSessionBleed();
  }

  private checkSerialization(): void {
    for (const [deviceId, max] of this.deviceMaxActive) {
      if (max > 1) {
        this.fail(
          'same-device serialization',
          `device ${deviceId} had ${max} overlapping critical sections`,
        );
      }
    }
    for (const [deviceId, active] of this.deviceActive) {
      if (active !== 0) {
        this.fail(
          'same-device serialization',
          `device ${deviceId} left ${active} critical sections open`,
        );
      }
    }
  }

  private checkLocksReleased(): void {
    try {
      this.scheduler.assertQuiescent();
    } catch (error) {
      this.fail('every lock released after owner death', (error as Error).message);
    }
  }

  private liveInstances(): SessionInstance[] {
    return [...this.instances.values()].filter((instance) => this.isInstanceLive(instance));
  }

  /** Flags any device key that appears more than once across `deviceKeys`. */
  private assertUniquePerDevice(
    deviceKeys: readonly string[],
    invariant: string,
    noun: string,
  ): void {
    const byDevice = new Map<string, number>();
    for (const key of deviceKeys) byDevice.set(key, (byDevice.get(key) ?? 0) + 1);
    for (const [deviceKey, count] of byDevice) {
      if (count > 1) this.fail(invariant, `device ${deviceKey} has ${count} ${noun}`);
    }
  }

  private checkStoreConsistency(): void {
    this.checkStoredSessionsUnique();
    this.checkShadowStoreParity();
  }

  private checkStoredSessionsUnique(): void {
    const seenDevices = new Map<string, string>();
    for (const session of this.sessionStore.values()) {
      if (session.name !== this.sessionStore.get(session.name)?.name) {
        this.fail('session store consistent', `session ${session.name} key/name mismatch`);
      }
      const priorName = seenDevices.get(session.device.id);
      if (priorName) {
        this.fail(
          'session store consistent',
          `device ${session.device.id} bound to both ${priorName} and ${session.name}`,
        );
      }
      seenDevices.set(session.device.id, session.name);
    }
  }

  private checkShadowStoreParity(): void {
    // Every live shadow instance must have a matching stored session, and vice versa.
    const liveInstances = this.liveInstances();
    for (const instance of liveInstances) {
      const stored = this.sessionStore.get(instance.name);
      if (!stored) {
        this.fail('session store consistent', `live instance ${instance.name} missing from store`);
      } else if (stored.lease?.leaseId !== instance.lease.leaseId) {
        this.fail('session store consistent', `stored ${instance.name} lease != shadow lease`);
      }
    }
    const storeCount = this.sessionStore.toArray().length;
    if (storeCount !== liveInstances.length) {
      this.fail(
        'session store consistent',
        `store has ${storeCount} sessions, shadow expects ${liveInstances.length}`,
      );
    }
  }

  private checkNoLeakedLeases(): void {
    const active = this.leaseRegistry.listActiveLeases();
    const liveLeaseIds = new Set(this.liveInstances().map((instance) => instance.lease.leaseId));
    for (const lease of active) {
      if (!liveLeaseIds.has(lease.leaseId)) {
        this.fail(
          'no leaked leases',
          `lease ${lease.leaseId} (device ${lease.deviceKey}) has no live session`,
        );
      }
    }
    for (const leaseId of liveLeaseIds) {
      if (!active.some((lease) => lease.leaseId === leaseId)) {
        this.fail('no leaked leases', `live session lease ${leaseId} missing from registry`);
      }
    }
    // Device exclusivity: at most one active lease per device key.
    const deviceKeys = active
      .map((lease) => lease.deviceKey)
      .filter((key): key is string => Boolean(key));
    this.assertUniquePerDevice(deviceKeys, 'no leaked leases', 'active leases');
  }

  private checkNoLeakedClaims(): void {
    const claims = this.claims.snapshot();
    for (const claim of claims) {
      if (!this.sessionStore.get(claim.session)) {
        this.fail(
          'no leaked claims',
          `claim on ${claim.deviceKey} owned by dead session ${claim.session}`,
        );
      }
    }
    this.assertUniquePerDevice(
      claims.map((claim) => claim.deviceKey),
      'no leaked claims',
      'claims',
    );
    this.checkLiveClaimsHeld();
  }

  private checkLiveClaimsHeld(): void {
    // Every live session must hold exactly its own claim.
    for (const session of this.sessionStore.values()) {
      if (!session.deviceClaim) continue;
      const owner = this.claims.ownerSession(session.deviceClaim.deviceKey);
      if (owner !== session.name) {
        this.fail(
          'no leaked claims',
          `session ${session.name} claim not held (owner=${String(owner)})`,
        );
      }
    }
  }

  private checkNoCrossSessionBleed(): void {
    // Each live session's stored lease/claim/device must be exactly the ones the
    // harness allocated for THAT instance — never another concurrent session's.
    for (const instance of this.instances.values()) {
      if (!this.isInstanceLive(instance)) continue;
      const stored = this.sessionStore.get(instance.name);
      if (!stored) continue;
      if (stored.device.id !== instance.deviceId) {
        this.fail(
          'no cross-session bleed',
          `${instance.name} device ${stored.device.id} != ${instance.deviceId}`,
        );
      }
      if (stored.deviceClaim?.deviceKey !== instance.deviceKey) {
        this.fail('no cross-session bleed', `${instance.name} claim key mismatch`);
      }
      if (stored.lease?.clientId !== `c${instance.ownerClient}`) {
        this.fail(
          'no cross-session bleed',
          `${instance.name} lease clientId != owner c${instance.ownerClient}`,
        );
      }
    }
  }

  private fail(invariant: string, detail: string): void {
    this.failures.push({ invariant, detail });
  }

  private cleanup(): void {
    try {
      fs.rmSync(this.stateRoot, { recursive: true, force: true });
    } catch {
      // Best effort; a leftover temp dir never fails the invariant check.
    }
  }
}
