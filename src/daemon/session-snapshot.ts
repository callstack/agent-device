import type { SnapshotState } from '../kernel/snapshot.ts';
import type { SessionState } from './types.ts';

/**
 * Warning attached to responses of commands that consume an `@ref` argument
 * while `session.snapshotRefsStale` is true (#1076). Warning, not error: the
 * command still executes, and the geometric guards (offscreen/covered/
 * STALE_REF) keep catching the cases where the drift is detectable.
 */
export const STALE_SNAPSHOT_REFS_WARNING =
  'The session snapshot changed since your refs were issued — @refs may now point at different elements. Re-run snapshot -i to refresh refs.';

/**
 * The single daemon-side write choke point for replacing a session's stored
 * snapshot outside the snapshot/diff command (which builds its next session in
 * `buildNextSnapshotSession`, src/daemon/snapshot-runtime.ts, and manages
 * `snapshotRefsStale` there because its response DOES hand refs to the client).
 *
 * Every caller of this function replaces the tree WITHOUT returning the new
 * refs to the client, so the stored refs the client holds become positionally
 * unreliable and `snapshotRefsStale` is set (#1076 honest marker):
 * - selector-capture-runtime.ts — find/get/is/wait selector captures
 * - selector-runtime-backend.ts — selector runtime session writes (get/wait)
 * - handlers/interaction-runtime.ts — press/click/fill selector-resolution and
 *   --verify evidence captures routed through the interaction runtime
 * - handlers/interaction-snapshot.ts — Android ref-freshness refreshes and
 *   recording reference-frame captures
 * - handlers/session-replay-heal.ts — replay heal re-captures
 * - request-generic-dispatch.ts — screenshot --overlay-refs capture (the
 *   overlay burns in at most a scored subset of refs, so it does NOT count as
 *   issuing the full ref set and stays conservative-stale)
 *
 * Cleared (set false) only where the client demonstrably receives the new
 * refs: the snapshot command response (buildNextSnapshotSession) and find
 * responses that return a ref minted from the freshly stored tree
 * (handlers/find.ts, dispatchFindReadOnlyViaRuntime in selector-runtime.ts).
 */
export function setSessionSnapshot(session: SessionState, snapshot: SnapshotState): void {
  if (session.snapshot !== snapshot) {
    session.snapshotRefsStale = true;
  }
  session.snapshot = snapshot;
  session.snapshotScopeSource = undefined;
  if (snapshot.comparisonSafe === true) {
    session.lastComparisonSafeSnapshot = snapshot;
  }
}

/** The response being returned hands the stored snapshot's refs to the client. */
export function markSessionSnapshotRefsIssued(session: SessionState): void {
  session.snapshotRefsStale = false;
}
