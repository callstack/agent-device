import { randomInt } from 'node:crypto';
import type { SettleObservation } from '@agent-device/contracts/interaction';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { activatePartialRefFrame, refFrameEpoch, refFrameState } from './ref-frame.ts';
import type { SessionState } from './types.ts';

/**
 * Warning attached to a read of an `@ref` argument once the ref frame has
 * expired (ADR 0014): a device side effect changed the screen since the refs
 * were issued, so the resolved value may not reflect the current UI. Read-only
 * consumers stay fail-open with this warning while the retained frame still
 * resolves the ref; mutations reject an expired-frame ref before dispatch.
 */
export const STALE_SNAPSHOT_REFS_WARNING =
  'The UI may have changed since these refs were issued, so they no longer represent current device state. Take a new snapshot before relying on or interacting with them.';

/**
 * The single daemon-side write choke point for replacing a session's stored
 * snapshot outside the snapshot/diff command (`buildNextSnapshotSession`,
 * src/daemon/snapshot-runtime.ts). It advances the observation generation but
 * does NOT touch the ref frame: replacing the latest observation is an
 * operational read, so it never expires, reactivates, or reindexes the
 * authorized frame (ADR 0014). Frame lifetime is owned solely by
 * `src/daemon/ref-frame.ts`; the partial-issuance writer below decides WHETHER to issue
 * and hands the transition there.
 */
export function setSessionSnapshot(session: SessionState, snapshot: SnapshotState): void {
  if (session.snapshot !== snapshot) {
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
 * The same lineage rule, applied to a freshly BUILT record instead of the stored one.
 * `snapshot-runtime.ts` constructs a new `SessionState` rather than mutating the one in the
 * store, so it cannot go through `setSessionSnapshot` — but the invariant it has to honour is
 * identical, and it is the invariant that matters: #1076 versioned refs require the observation
 * counter to advance exactly when the stored tree is replaced, for `snapshot` and `diff` alike,
 * and the scope source must describe the tree that actually ended up there.
 *
 * Advancing the counter is NOT the same as invalidating client refs, and the comment this
 * replaced said otherwise — it claimed a diff leaves refs pinned to the previous generation
 * "which is exactly what the pinned warning diagnoses". It does not: `diff` passes
 * `issuesRefsToClient: false`, so it never reactivates the frame, and
 * `resolveRefStalenessWarning` compares a pin against the frame EPOCH rather than this counter,
 * precisely so a capture that bumped the counter cannot make a valid pin look stale. A ref
 * pinned before a diff therefore keeps resolving, with no warning, by design (ADR 0014).
 * `session-snapshot.test.ts` pins that outcome so the claim cannot drift back.
 *
 * Both fields move together, here, next to the writer they have to agree with. They used to be
 * assigned at the call site, which is how the rule came to have two statements of itself in two
 * modules.
 */
export function setSnapshotLineage(
  session: SessionState,
  params: {
    scopeSource: SnapshotState | undefined;
    keptCurrentSnapshot: boolean;
    previousGeneration: number | undefined;
  },
): void {
  session.snapshotScopeSource = params.scopeSource;
  session.snapshotGeneration = params.keptCurrentSnapshot
    ? params.previousGeneration
    : nextSnapshotGeneration(params.previousGeneration);
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
function nextSnapshotGeneration(current: number | undefined): number {
  return current === undefined ? randomInt(100_000, 1_000_000) : current + 1;
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
  // leaves ALL session state untouched, including the ref frame fields set
  // below. Build the scope before touching anything so a no-ref result is a
  // true no-op.
  if (scope.size === 0) return;
  // The frame transition itself belongs to ref-frame.ts, which owns all four fields: the
  // tree retained as the frame's immutable source (interaction guards and replay identity
  // depend on ancestors, siblings and viewport outside the emitted subset, so the whole
  // tree is kept while the issuance set bounds authority) and the frozen epoch that keeps
  // a later read-only capture from invalidating a correct pin from this frame.
  activatePartialRefFrame(session, scope);
}

/**
 * #1101 `--settle`: a settle observation carrying a diff hands the client refs
 * minted from the freshly stored settled tree (added lines carry them), which
 * makes the response ref-issuing like snapshot/find: it activates a PARTIAL
 * frame (ADR 0014) authorizing exactly those bodies, and returns the stored
 * tree's generation to ride inside the settle payload for MCP per-ref pinning.
 * Without a diff — never captured, or a sparse-quality capture that was not
 * stored — nothing was issued and the frame is left as the action's own
 * side-effect seam expired it.
 *
 * Every route that can attach a settle observation goes through here (the
 * touch commands and the generic scroll/back route, #1638), so the issuance
 * rule has one implementation beside the partial-frame primitive it wraps.
 */
export function issueSettleRefs(
  session: SessionState,
  settle: SettleObservation | undefined,
): number | undefined {
  if (!settle?.diff) return undefined;
  markSessionPartialRefsIssued(session, collectSettleIssuedRefBodies(settle));
  return session.snapshotGeneration;
}

/** The reusable refs a settled diff exposed: added diff lines, `refs`, `tail`. */
function collectSettleIssuedRefBodies(settle: SettleObservation): string[] {
  const bodies: string[] = [];
  for (const line of settle.diff?.lines ?? []) {
    if (line.ref) bodies.push(line.ref);
  }
  for (const entry of settle.refs ?? []) bodies.push(entry.ref);
  for (const entry of settle.tail ?? []) bodies.push(entry.ref);
  return bodies;
}

/**
 * Warning for a ref pinned to a generation (`@e12~s3`) whose epoch no longer
 * matches the session's current ref-frame epoch (`refFrameEpoch`) — NOT the
 * latest observation generation. A read-only capture bumps the observation
 * counter without re-issuing the frame, so the two can diverge; the warning
 * names the frame epoch the pin is actually compared against. Unlike
 * STALE_SNAPSHOT_REFS_WARNING it is PRECISE: the pin proves which frame minted
 * the ref, so the mismatch is a fact, not a conservative marker.
 */
function buildPinnedStaleRefWarning(params: {
  ref: string;
  mintedGeneration: number;
  currentFrameEpoch: number;
}): string {
  const plainRef = params.ref.startsWith('@') ? params.ref.slice(1) : params.ref;
  return `Ref @${plainRef} was minted from snapshot s${params.mintedGeneration} but the session's ref frame is now s${params.currentFrameEpoch} — re-run snapshot -i.`;
}

/**
 * Staleness warning for a command consuming an `@ref` argument (ADR 0014).
 * Frame expiry is checked FIRST, matching the admission order (evidence #17): an
 * expired frame means a device side effect changed the screen since issuance, so
 * a read is stale even when a pin matches the epoch — a matching pin proves
 * identity within the retained frame, not that the UI is current.
 * - frame expired → the coarse staleness warning (any ref);
 * - active frame, pinned ref with a different epoch → the precise pinned warning;
 * - active frame, pin matching the epoch or a plain ref → no warning. A read-only
 *   capture no longer marks refs stale, because it does not expire the frame.
 *
 * This resolver is advisory; command handlers may enforce stronger freshness
 * policy. In particular, a ref mutation rejects an expired-frame ref before
 * dispatch.
 */
export function resolveRefStalenessWarning(params: {
  session: SessionState | undefined;
  ref: string;
  mintedGeneration: number | undefined;
}): string | undefined {
  const { session, ref, mintedGeneration } = params;
  if (session && refFrameState(session) === 'expired') return STALE_SNAPSHOT_REFS_WARNING;
  if (mintedGeneration !== undefined) {
    // Compare against the FRAME epoch (frozen at issuance), not the observation
    // counter — a read-only capture that bumped `snapshotGeneration` must not
    // make a valid pin from the issuing frame look stale.
    const currentFrameEpoch = session ? (refFrameEpoch(session) ?? 0) : 0;
    if (mintedGeneration !== currentFrameEpoch) {
      return buildPinnedStaleRefWarning({ ref, mintedGeneration, currentFrameEpoch });
    }
  }
  return undefined;
}
