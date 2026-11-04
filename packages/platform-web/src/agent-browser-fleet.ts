import type { OwnedProcessRecordStore } from '@agent-device/host-kit/process';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';

const RECORD_LOCK_KEY = 'managed-web-browser-record';

/**
 * The managed browser fleet one daemon owns, as seen from its owned-process record store.
 *
 * Browsers join the fleet when their `open` starts, not when the daemon publishes the session, so
 * a close that decides whether the record is still needed counts a browser that is launching or
 * launched but not yet published. Providers are created per request; the record store is the one
 * object they all share, so it keys the fleet.
 *
 * Every update of the record runs through {@link AgentBrowserFleet.updateRecord}, one at a time:
 * a scan that read the process table before a browser launched cannot overwrite the record a later
 * scan wrote for it.
 */
export type AgentBrowserFleet = Readonly<{
  updateRecord<T>(task: () => Promise<T>): Promise<T>;
  /** An `open` for `session` is about to launch its browser. */
  openStarted(session: string): void;
  /** The `open` for `session` ended; `launched` is whether the browser is up. */
  openSettled(session: string, launched: boolean): void;
  /** The browser of `session` was closed. */
  closed(session: string): void;
  /** The sessions whose browser is launching or up, whether or not the daemon published them. */
  sessions(): readonly string[];
}>;

const fleets = new WeakMap<OwnedProcessRecordStore, AgentBrowserFleet>();

export function agentBrowserFleetOf(store: OwnedProcessRecordStore): AgentBrowserFleet {
  const existing = fleets.get(store);
  if (existing) return existing;
  const fleet = createAgentBrowserFleet();
  fleets.set(store, fleet);
  return fleet;
}

function createAgentBrowserFleet(): AgentBrowserFleet {
  const recordLocks = new Map<string, Promise<unknown>>();
  const opening = new Map<string, number>();
  const launched = new Set<string>();
  return Object.freeze({
    updateRecord: async (task) => await withKeyedLock(recordLocks, RECORD_LOCK_KEY, task),
    openStarted(session) {
      opening.set(session, (opening.get(session) ?? 0) + 1);
    },
    openSettled(session, browserUp) {
      const remaining = (opening.get(session) ?? 1) - 1;
      if (remaining > 0) opening.set(session, remaining);
      else opening.delete(session);
      if (browserUp) launched.add(session);
    },
    closed(session) {
      launched.delete(session);
    },
    sessions: () => [...new Set([...opening.keys(), ...launched])],
  });
}
