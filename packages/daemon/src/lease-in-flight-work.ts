/**
 * Which leased devices have admitted request work running on them right now.
 *
 * A remote lease renews when a request is admitted and never again while that
 * request works, so a command that legitimately outlives its lease's inactivity
 * TTL expired the very lease paying for the device it was using, and the session
 * with it. The daemon's default inactivity TTL is one minute; a cloud WebDriver
 * connection profile asks for ten, which decides which leases this reaches.
 */

/** Whether the client behind one request is still waiting for its result. */
export type LeaseWorkWanted = () => boolean;

/** A claim on one leased device for the duration of one admitted request's work. */
export type LeaseWorkPass = Readonly<{
  leaseId: string;
  /**
   * Ends the pass. Reports whether the work was still wanted when it ended, which
   * is what entitles it to renew the lease it just worked on.
   */
  release(): boolean;
}>;

type LeaseWorkEntry = {
  readonly wanted: LeaseWorkWanted;
  released: boolean;
};

/**
 * A pass defers its lease's expiry for as long as the request that opened it is
 * still wanted. The moment that client hangs up the pass defers nothing, so a
 * handler that ignores its cancellation cannot hold a rented device open.
 */
export class LeaseInFlightWorkRegistry {
  private readonly entriesByLeaseId = new Map<string, Set<LeaseWorkEntry>>();

  retain(leaseId: string, wanted: LeaseWorkWanted): LeaseWorkPass {
    const entry: LeaseWorkEntry = { wanted, released: false };
    const entries = this.entriesByLeaseId.get(leaseId) ?? new Set<LeaseWorkEntry>();
    entries.add(entry);
    this.entriesByLeaseId.set(leaseId, entries);
    return { leaseId, release: () => this.releasePass(leaseId, entries, entry) };
  }

  /**
   * Drops every claim on a lease that no longer exists, and marks them released so
   * work that outlives its own lease renews nothing — including a lease later
   * allocated under the same id.
   */
  forget(leaseId: string): void {
    const entries = this.entriesByLeaseId.get(leaseId);
    if (!entries) return;
    for (const entry of entries) {
      entry.released = true;
    }
    this.entriesByLeaseId.delete(leaseId);
  }

  /** True while any pass on this lease is still wanted. Unwanted passes defer nothing. */
  isDeferred(leaseId: string): boolean {
    const entries = this.entriesByLeaseId.get(leaseId);
    if (!entries) return false;
    for (const entry of entries) {
      if (entry.wanted()) continue;
      entries.delete(entry);
    }
    if (entries.size > 0) return true;
    this.entriesByLeaseId.delete(leaseId);
    return false;
  }

  /** Idempotent: only the first release of a pass can report its work as wanted. */
  private releasePass(
    leaseId: string,
    entries: Set<LeaseWorkEntry>,
    entry: LeaseWorkEntry,
  ): boolean {
    if (entry.released) return false;
    entry.released = true;
    entries.delete(entry);
    if (entries.size === 0) this.entriesByLeaseId.delete(leaseId);
    return entry.wanted();
  }
}
