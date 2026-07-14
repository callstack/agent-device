import { randomInt } from 'node:crypto';
import type { SnapshotState } from '../kernel/snapshot.ts';
import { refFrameEpoch } from './ref-frame.ts';
import type { SessionState } from './types.ts';

/**
 * Warning attached to responses of commands that consume an `@ref` argument
 * while `session.snapshotRefsStale` is true (#1076). Read-only consumers remain
 * warn-only. iOS ref mutations reject stale refs before dispatch (#1239).
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
 * - request-generic-dispatch.ts — screenshot --overlay-refs capture (the
 *   overlay burns in at most a scored subset of refs, so it does NOT count as
 *   issuing the full ref set and stays conservative-stale)
 *
 * Cleared (set false) only where the client demonstrably receives the new
 * refs: the snapshot command response (buildNextSnapshotSession), find
 * responses that return a ref minted from the freshly stored tree
 * (handlers/find.ts, dispatchFindReadOnlyViaRuntime in selector-runtime.ts),
 * interaction --settle responses whose settled diff carries refs minted
 * from the freshly stored settled tree (settleRefsGenerationIssue in
 * handlers/interaction-touch.ts — the same accepted coarse blessing as find's
 * single re-issued ref; per-ref precision is the MCP pin layer's job), and
 * replay divergence reports whose screen digest hands out refs from the
 * freshly stored post-failure tree (captureDivergenceObservation in
 * handlers/session-replay-divergence.ts, ADR 0012 migration step 2).
 */
export function setSessionSnapshot(session: SessionState, snapshot: SnapshotState): void {
  if (session.snapshot !== snapshot) {
    session.snapshotRefsStale = true;
    // #1076 versioned refs: every tree replacement advances the session's
    // snapshot generation, so refs pinned to an earlier generation
    // (`@e12~s3`) can be diagnosed precisely.
    session.snapshotGeneration = nextSnapshotGeneration(session.snapshotGeneration);
  }
  session.snapshot = snapshot;
  session.snapshotScopeSource = undefined;
  if (snapshot.comparisonSafe === true) {
    session.lastComparisonSafeSnapshot = snapshot;
  }
}

/**
 * Advance `snapshotGeneration` (#1076 versioned refs). The FIRST bump of a
 * session lifetime seeds at a random 6-digit base instead of 1: a reopened
 * session restarts its counter, so a per-lifetime count starting at 1 would
 * let a stale `@e1~s1` pin from the previous lifetime silently read as
 * current. With a seeded base, cross-lifetime collisions are ~1e-6 instead of
 * common — the protection is probabilistic (seeded), NOT identity-based.
 * Within a lifetime the counter stays strictly monotonic (+1 per replacement),
 * so pinned-vs-current comparisons remain exact.
 */
export function nextSnapshotGeneration(current: number | undefined): number {
  return current === undefined ? randomInt(100_000, 1_000_000) : current + 1;
}

/**
 * The response being returned hands the stored snapshot's refs to the client.
 *
 * ADR 0014: this clears the coarse client marker but must NOT re-authorize a
 * complete frame — restoring broad `all`-scope mutation authority from a partial
 * result is the ADR hole. Only a complete namespace (the snapshot command, via
 * `buildNextSnapshotSession`) re-activates a complete frame. A partial
 * publication that wants to authorize its bounded ref set calls
 * {@link markSessionPartialRefsIssued} instead.
 */
export function markSessionSnapshotRefsIssued(session: SessionState): void {
  session.snapshotRefsStale = false;
}

/** Plain ref body: strip a leading `@` and any `~s<n>` generation suffix. */
function normalizeRefBody(ref: string): string {
  const withoutAt = ref.startsWith('@') ? ref.slice(1) : ref;
  const suffix = withoutAt.indexOf('~');
  return suffix === -1 ? withoutAt : withoutAt.slice(0, suffix);
}

/**
 * ADR 0014 partial issuance: a `find`, settled diff, or replay divergence screen
 * publishes only the refs it actually returned. It activates a PARTIAL frame that
 * authorizes ONLY those ref bodies (scope = the emitted set) at the current
 * epoch — a plain ref then requires a complete frame, and a pinned ref outside
 * the set is rejected. An empty partial result does not supersede existing
 * authority (it leaves the frame untouched), so a useful prior frame survives.
 */
export function markSessionPartialRefsIssued(session: SessionState, refs: Iterable<string>): void {
  const scope = new Set<string>();
  for (const ref of refs) {
    const body = normalizeRefBody(ref);
    if (body.length > 0) scope.add(body);
  }
  // ADR 0014: an empty partial result does not supersede existing authority — it
  // leaves ALL session state untouched, including the coarse marker. Build the
  // scope before touching anything so a no-ref result is a true no-op.
  if (scope.size === 0) return;
  session.snapshotRefsStale = false;
  session.refFrameState = 'active';
  session.refFrameScope = scope;
  // ADR 0014: retain the tree this partial result published from as the frame's
  // immutable source (shared reference — the caller already stored it via
  // setSessionSnapshot). Interaction guards and replay identity can depend on
  // ancestors, siblings, and viewport outside the emitted subset, so the whole
  // tree is kept while the issuance set bounds authority.
  session.refFrameTree = session.snapshot;
  // Freeze the epoch the client is handed (the response-level refsGeneration),
  // so a later read-only capture that bumps the observation counter cannot
  // invalidate a correct pin from this frame.
  session.refFrameGeneration = session.snapshotGeneration;
}

/**
 * Warning for a ref pinned to a generation (`@e12~s3`) that no longer matches
 * the stored tree's generation. Unlike STALE_SNAPSHOT_REFS_WARNING it is
 * PRECISE: the pin proves which tree minted the ref, so the mismatch is a
 * fact, not a conservative marker.
 */
function buildPinnedStaleRefWarning(params: {
  ref: string;
  mintedGeneration: number;
  currentGeneration: number;
}): string {
  const plainRef = params.ref.startsWith('@') ? params.ref.slice(1) : params.ref;
  return `Ref @${plainRef} was minted from snapshot s${params.mintedGeneration} but the session tree is now s${params.currentGeneration} — re-run snapshot -i.`;
}

/**
 * Staleness warning for a command consuming an `@ref` argument (#1076):
 * - pinned ref (`@e12~s3`) matching the stored generation → no warning, even
 *   while the coarse `snapshotRefsStale` marker is set (the pin proves the
 *   client's ref came from the stored tree);
 * - pinned ref with any other generation → the precise pinned warning;
 * - plain ref → the coarse #1093 marker behavior, unchanged.
 *
 * This resolver is advisory; command handlers may enforce stronger freshness
 * policy. In particular, iOS ref mutations reject a stale ref before dispatch
 * (#1239).
 */
export function resolveRefStalenessWarning(params: {
  session: SessionState | undefined;
  ref: string;
  mintedGeneration: number | undefined;
}): string | undefined {
  const { session, ref, mintedGeneration } = params;
  if (mintedGeneration !== undefined) {
    // ADR 0014: compare against the FRAME epoch (frozen at issuance), not the
    // observation counter — a read-only capture that bumped `snapshotGeneration`
    // must not make a valid pin from the issuing frame look stale.
    const currentGeneration = session ? (refFrameEpoch(session) ?? 0) : 0;
    if (mintedGeneration === currentGeneration) return undefined;
    return buildPinnedStaleRefWarning({ ref, mintedGeneration, currentGeneration });
  }
  return session?.snapshotRefsStale === true ? STALE_SNAPSHOT_REFS_WARNING : undefined;
}
