import type { SessionState } from './types.ts';

/**
 * ADR 0014 session ref-frame lifetime — the authorization model for mutation
 * refs, kept distinct from the latest operational observation (`session.snapshot`).
 *
 * A session owns at most one **ref frame**: the namespace whose refs a caller
 * may use to target a mutation. This module is the single owner of the frame's
 * transitions and of the admission decision. It is introduced behind the
 * existing `snapshotGeneration` (the frame epoch) and `snapshotRefsStale` (the
 * coarse client-stale marker) fields, which keep their wire-visible names
 * (`refsGeneration`, the `@e12~s42` pin grammar) for compatibility.
 *
 * Migration status: this step introduces the model and the admission matrix and
 * routes the existing iOS stale-ref enforcement (#1241) through it. Frame
 * expiration at the device side-effect seam, non-`all` issuance scope, and
 * fail-closed enforcement on other platforms land in later steps; until then a
 * frame is always `active` with scope `all`, so `admitRefMutation` reduces to
 * the generation-pin check that path already performed.
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
 */
export function expireRefFrame(session: SessionState): void {
  session.refFrameState = 'expired';
}

/**
 * Re-authorize a complete frame with scope `all` (ADR 0014). This is the only
 * transition that restores plain-ref mutation after an expiry, and it is
 * reserved for a COMPLETE namespace publication (the snapshot command). Partial
 * publications (`find`, settled diffs, replay divergence) and internal read
 * captures never call it, so a partial result cannot restore broad authority.
 *
 * Retains the just-published tree (`session.snapshot`) as the frame's immutable
 * source tree by SHARED reference — no deep copy (ADR 0014 performance). A later
 * read-only capture advances `session.snapshot` without disturbing this tree, so
 * a ref keeps resolving against the namespace that authorized it.
 */
export function activateCompleteRefFrame(session: SessionState): void {
  session.refFrameState = 'active';
  session.refFrameScope = undefined;
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
