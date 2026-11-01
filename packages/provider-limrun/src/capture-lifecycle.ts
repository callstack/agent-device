import type {
  LimrunLeaseOwner,
  LimrunOwnerCapture,
  LimrunRuntimeSession,
} from './lease-ownership.ts';
import type { NetworkCapture, SettledNetworkCapture } from './network-har.ts';
import { awaitLimrunWithinBudget } from './lifecycle-budget.ts';
import { errorMessage } from '@agent-device/kernel/errors';

/**
 * How long a read or a teardown waits for a destination tunnel that is still being opened. The SDK gives this
 * handshake fifteen seconds of its own; the extra five seconds is this runtime's margin over it. Exported
 * because the disposal that joins a capture end must give it more than this: `end` waits the handshake inside
 * its own call, and a join shorter than it would report a stalled-but-in-budget handshake as a refused record.
 */
export const CAPTURE_OPEN_BUDGET_MS = 20_000;

/** Released captures stay listable; the oldest settled records are forgotten past this count. */
const SETTLED_NETWORK_CAPTURE_LIMIT = 32;

export type LimrunCaptureHost = Readonly<{
  /** Where each lease's HAR goes. Without it a capture is unavailable and nothing is opened. */
  harDir: string | undefined;
  /** The live session of an owner, and nothing once a teardown has taken the lease. */
  liveSessionOf(owner: LimrunLeaseOwner): LimrunRuntimeSession | undefined;
  /** The leases this runtime holds, which is what the record limit spares from forgetting. */
  heldOwners(): Iterable<LimrunLeaseOwner>;
}>;

/**
 * What one lease's network capture goes through: starting it, ending it, and answering what `artifacts` can
 * say about it. The owner is where a capture lives, including a start whose destination tunnel is still being
 * opened, so the allocation that started one, a release that took the lease over, and an artifacts read all
 * look at the same thing and none of them can end up owning a tunnel nobody can close.
 */
export class LimrunCaptureLifecycle {
  /** The capture records this lifecycle settled, which outlive their lease so `artifacts` can still name them. */
  private readonly settled = new Map<string, SettledNetworkCapture>();
  private readonly host: LimrunCaptureHost;

  constructor(host: LimrunCaptureHost) {
    this.host = host;
  }

  /**
   * Starts this lease's capture, or joins the start its owner is already running. The owner records that start
   * before anything is awaited, so a repeat allocation cannot open a second destination tunnel whose
   * `already_active` refusal would be reported over the capture that is working, and a teardown that takes the
   * lease meanwhile finds a tunnel that is not there yet and ends it where it lands.
   */
  async start(owner: LimrunLeaseOwner, hostList: unknown): Promise<void> {
    const held = owner.capture;
    if (held?.phase === 'starting') {
      // Joining another allocation's destination tunnel is waited for within the budget a read or a teardown
      // gives that same handshake, and its outcome changes nothing here: the start keeps its own owner to
      // publish to, and this lease's teardown is the route that ends whatever tunnel it opens. So a handshake
      // that stops answering costs this caller its wait, and nothing else.
      await awaitLimrunWithinBudget(held.opening, CAPTURE_OPEN_BUDGET_MS);
      return;
    }
    const harDir = this.host.harDir;
    if (!harDir) {
      owner.capture = { phase: 'unavailable', reason: 'capture-dir-unset' };
      return;
    }
    // Only a live lease can capture: a release or a shutdown that took this owner is not a caller a new
    // destination tunnel could be handed to, and nothing here would own it afterwards.
    const session = this.host.liveSessionOf(owner);
    if (!session) return;
    let reportOpened!: (capture: NetworkCapture) => void;
    const opening = new Promise<NetworkCapture>((opened) => {
      reportOpened = opened;
    });
    owner.capture = { phase: 'starting', opening };
    const hosts = hostsToCapture(hostList);
    // Started after the publication above, and nothing between the two lets a second start through. A start
    // that could not be attempted at all is reported the same way, so nothing waits on a tunnel that is never
    // coming, and the outcome is published before the waiting allocation is answered.
    const publish = (capture: NetworkCapture): void => {
      // A teardown took the capture over, and what this tunnel came to is that teardown's to end: nothing
      // here hands a destination tunnel to a lease that is on its way out.
      const current = owner.capture;
      if (current !== undefined && current.phase === 'starting' && current.opening === opening) {
        owner.capture = capture;
      }
      reportOpened(capture);
    };
    void openCapture(session.client, harDir, owner.lease.leaseId, hosts).then(
      publish,
      (error: unknown) =>
        publish({
          phase: 'unavailable',
          reason: 'tunnel-start-failed',
          message: errorMessage(error),
        }),
    );
    await opening;
  }

  /**
   * Takes this owner's capture off it and ends it, keeping the record it came to so `artifacts` can still
   * answer for the HAR after the lease is gone. Whatever its phase, the capture leaves the owner here: this is
   * the disposal route, and the one route that owns a tunnel whose open had not answered yet.
   */
  async end(owner: LimrunLeaseOwner): Promise<SettledNetworkCapture | undefined> {
    const leaseId = owner.lease.leaseId;
    const state = owner.capture;
    if (state === undefined) return this.settled.get(leaseId);
    owner.capture = undefined;
    if (state.phase !== 'starting') return await endCapture(leaseId, state, this.record);
    // A destination tunnel still being opened is waited for within a budget. A tunnel that answers later is
    // written and ended by the continuation below all the same, so it is never left without an owner.
    const opened = await awaitLimrunWithinBudget(state.opening, CAPTURE_OPEN_BUDGET_MS);
    if (opened.ok) return await endCapture(leaseId, opened.value, this.record);
    // Observed end to end: this continuation outlives its budget, so neither a late tunnel that refuses to be
    // written nor one whose close refuses may reach the process as an unhandled rejection. The tunnel it could
    // not end stays the host's, reported by nothing else.
    void state.opening
      .then(async (late) => {
        await endCapture(leaseId, late, this.record);
      })
      .catch(() => undefined);
    return this.settled.get(leaseId);
  }

  /**
   * What `artifacts` answers for one lease: its capture written now while the lease is held, and the record a
   * release settled after the lease is gone. A lease this lifecycle never held answers nothing.
   */
  async list(
    leaseId: string,
    held: LimrunOwnerCapture | undefined,
  ): Promise<SettledNetworkCapture | undefined> {
    if (held === undefined) return this.settled.get(leaseId);
    if (held.phase !== 'starting') {
      const { writeCaptureRecord } = await import('./network-har.ts');
      return await writeCaptureRecord(held);
    }
    // A capture whose tunnel is still being opened has no traffic to report yet, and this read is not the
    // route that owns that tunnel: its release is. Waiting the open budget here would hold an `artifacts`
    // request for a handshake whose outcome this read cannot act on, so the read answers now with whatever
    // record this lease already has and lets the release write the rest.
    return this.settled.get(leaseId);
  }

  /** Keeps one released capture's record, forgetting the oldest once the record limit is passed. */
  private readonly record = (
    leaseId: string,
    capture: SettledNetworkCapture,
  ): SettledNetworkCapture => {
    // Re-insertion keeps the records in settle order, so the oldest released one is the first to go.
    this.settled.delete(leaseId);
    this.settled.set(leaseId, capture);
    this.forgetRecordsOverLimit();
    return capture;
  };

  /**
   * Forgets the oldest released capture once every record this lifecycle can answer for passes the limit. A
   * lease whose owner still holds a capture keeps its own record: the limit counts those captures, so the very
   * same test spares them, and a record of any other lease is the oldest thing here to throw away.
   */
  private forgetRecordsOverLimit(): void {
    const held = this.heldCaptures();
    while (this.settled.size + held.size > SETTLED_NETWORK_CAPTURE_LIMIT) {
      const released = [...this.settled.keys()].find((leaseId) => !held.has(leaseId));
      if (released === undefined) return;
      this.settled.delete(released);
    }
  }

  /** The leases whose owners still hold a capture: counted by the record limit and spared by it, one test both. */
  private heldCaptures(): Set<string> {
    const leaseIds = new Set<string>();
    for (const owner of this.host.heldOwners()) {
      if (owner.capture !== undefined) leaseIds.add(owner.lease.leaseId);
    }
    return leaseIds;
  }
}

/** Opens one capture's destination tunnel, or says why it could not. */
async function openCapture(
  client: LimrunRuntimeSession['client'],
  harDir: string,
  leaseId: string,
  hosts: readonly string[],
): Promise<NetworkCapture> {
  const { limrunHarPath, startLimrunHarCapture } = await import('./network-har.ts');
  const result = await startLimrunHarCapture(client, hosts.length > 0 ? hosts : undefined);
  return result.ok
    ? { phase: 'capturing', harPath: limrunHarPath(harDir, leaseId), capture: result.capture }
    : { phase: 'unavailable', reason: result.reason, message: result.message };
}

/**
 * Ends one capture: writes its HAR, closes its tunnel, and keeps the record listable. The record is written
 * before the tunnel is closed, because its failure counts are read from the capture that is about to go.
 */
async function endCapture(
  leaseId: string,
  capture: NetworkCapture,
  record: (leaseId: string, capture: SettledNetworkCapture) => SettledNetworkCapture,
): Promise<SettledNetworkCapture> {
  const { writeCaptureRecord } = await import('./network-har.ts');
  const settled = await writeCaptureRecord(capture);
  if (capture.phase === 'capturing') capture.capture.close();
  return record(leaseId, settled);
}

function hostsToCapture(hostList: unknown): string[] {
  return typeof hostList === 'string'
    ? hostList
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean)
    : [];
}
