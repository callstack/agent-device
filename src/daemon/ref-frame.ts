import type { SessionState } from './types.ts';

const runtimeRevisions = new WeakMap<SessionState, number>();

/**
 * ADR 0014 session ref-frame lifetime — the authorization model for mutation
 * refs, kept distinct from the latest operational observation (`session.snapshot`).
 *
 * A session owns at most one **ref frame**: the namespace whose refs a caller
 * may use to target a mutation. This module is the single owner of the frame's
 * transitions and of the admission decision. The frame epoch reuses the existing
 * `snapshotGeneration`/`refsGeneration` counter and the `@e12~s42` pin grammar
 * for wire compatibility.
 *
 * The frame is expired at the device side-effect seam, carries a non-`all`
 * issuance scope after a partial publication, and its admission matrix is
 * enforced fail-closed on every platform before dispatch (ADR 0014 steps 3–7).
 * Read-only ref staleness is now derived from frame state (an expired frame
 * warns; an active one does not) rather than a coarse client-stale marker, which
 * migration step 8 removed.
 */

/**
 * Issuance scope of the current frame: `all` for a complete namespace (a full
 * interactive snapshot), or the bounded set of ref bodies a partial publication
 * (`find`, settled diff, replay divergence) actually returned.
 */
export type RefFrameScope = 'all' | ReadonlySet<string>;

/** Lifecycle state of the current frame. */
export type RefFrameState = 'active' | 'expired';

/**
 * Typed admission-failure reasons, evaluated in this order so the caller can
 * distinguish "capture a complete snapshot" from "use the emitted pinned ref".
 */
export type RefFrameRejectReason =
  | 'ref_frame_expired'
  | 'ref_generation_mismatch'
  | 'plain_ref_requires_complete_frame'
  | 'ref_not_issued';

export type RefFrameAdmission =
  | { admitted: true }
  | { admitted: false; reason: RefFrameRejectReason };

/**
 * The frame epoch exposed to clients as `refsGeneration`. Frozen at issuance
 * (`refFrameGeneration`) so a later read-only capture that advances the
 * observation counter (`snapshotGeneration`) does not shift the epoch a valid
 * pin is compared against. Falls back to `snapshotGeneration` for pre-frame
 * sessions.
 */
export function refFrameEpoch(session: SessionState): number | undefined {
  return session.refFrameGeneration ?? session.snapshotGeneration;
}

/**
 * Expire the current frame at a device side-effect seam (ADR 0014). Idempotent:
 * additional effects while already expired are a no-op. Call this SYNCHRONOUSLY,
 * immediately before awaiting the operation that may change device-visible
 * element identity, so that a post-dispatch failure (timeout, connection loss,
 * ambiguous error) still leaves the frame expired — there is no success-only
 * rollback.
 *
 * Crossing the seam also clears the scoped-snapshot lineage (`snapshotScopeSource`,
 * ADR 0014): a mutation breaks the consecutive `snapshot -s @ref` chain, so a
 * later repeated scoped snapshot cannot borrow stale lineage across a device
 * side effect.
 */
export function expireRefFrame(session: SessionState): void {
  advanceSessionRuntimeRevision(session);
  session.refFrameState = 'expired';
  session.snapshotScopeSource = undefined;
}

/**
 * Monotonic, daemon-private revision for side-effect lineage. Unlike the
 * client-visible snapshot/ref generations, this advances for every possible
 * device mutation, including another mutation while the ref frame is already
 * expired. Internal observation evidence uses it to refuse publication after
 * any intervening side-effect seam.
 */
function advanceSessionRuntimeRevision(session: SessionState): number {
  const next = readSessionRuntimeRevision(session) + 1;
  runtimeRevisions.set(session, next);
  return next;
}

export function readSessionRuntimeRevision(session: SessionState): number {
  return runtimeRevisions.get(session) ?? 0;
}

/**
 * Re-authorize a complete frame with scope `all` (ADR 0014). This is the only
 * transition that restores plain-ref mutation after an expiry, and it is
 * reserved for a COMPLETE namespace publication (the snapshot command). Partial
 * publications (`find`, settled diffs, replay divergence) and internal read
 * captures never call it, so a partial result cannot restore broad authority.
 *
 * Retention and epoch semantics are shared with partial issuance; see
 * {@link activateRefFrame}.
 */
export function activateCompleteRefFrame(session: SessionState): void {
  activateRefFrame(session, undefined);
}

/**
 * ADR 0014 partial issuance: activate a frame that authorizes ONLY `scope`, the set of ref
 * bodies a `find`, settled diff, or replay divergence screen actually returned. A plain ref
 * then requires a complete frame, and a pinned ref outside the set is rejected.
 *
 * The caller decides whether a partial result should supersede existing authority — an
 * empty result must not (see `markSessionPartialRefsIssued`) — but the transition itself
 * belongs here, with the complete form, because the two differ only in scope.
 */
export function activatePartialRefFrame(session: SessionState, scope: ReadonlySet<string>): void {
  activateRefFrame(session, scope);
}

/**
 * The frame's four fields move together or the frame is incoherent: an `active` state with a
 * stale `refFrameTree` resolves refs against a namespace nobody authorized, and a frame
 * pinned to the wrong `refFrameGeneration` invalidates correct pins. Both issuance forms
 * therefore land here rather than each writing the four fields itself.
 *
 * Retains the just-published tree (`session.snapshot`) as the frame's immutable source by
 * SHARED reference — no deep copy (ADR 0014 performance). A later read-only capture advances
 * `session.snapshot` without disturbing this tree, so a ref keeps resolving against the
 * namespace that authorized it.
 */
function activateRefFrame(session: SessionState, scope: ReadonlySet<string> | undefined): void {
  session.refFrameState = 'active';
  session.refFrameScope = scope;
  session.refFrameTree = session.snapshot;
  session.refFrameGeneration = session.snapshotGeneration;
}

export function refFrameState(session: SessionState): RefFrameState {
  return session.refFrameState ?? 'active';
}

export function refFrameScope(session: SessionState): RefFrameScope {
  return session.refFrameScope ?? 'all';
}

/**
 * The ADR 0014 mutation-admission matrix, evaluated in reason order. Pure over
 * the session's frame fields; it does not itself read the operational
 * observation, so an internal read capture cannot admit or reject a mutation by
 * positional coincidence.
 *
 * `refBody` is the plain ref body (no `@`, no `~s<n>` suffix). `mintedGeneration`
 * is the generation carried by a pinned input (`@e12~s42`), or `undefined` for a
 * plain ref.
 */
export function admitRefMutation(params: {
  session: SessionState;
  refBody: string;
  mintedGeneration: number | undefined;
}): RefFrameAdmission {
  const { session, refBody, mintedGeneration } = params;

  if (refFrameState(session) === 'expired') {
    return { admitted: false, reason: 'ref_frame_expired' };
  }

  if (mintedGeneration !== undefined && mintedGeneration !== refFrameEpoch(session)) {
    return { admitted: false, reason: 'ref_generation_mismatch' };
  }

  const scope = refFrameScope(session);
  if (scope !== 'all') {
    if (mintedGeneration === undefined) {
      return { admitted: false, reason: 'plain_ref_requires_complete_frame' };
    }
    if (!scope.has(refBody)) {
      return { admitted: false, reason: 'ref_not_issued' };
    }
  }

  return { admitted: true };
}
