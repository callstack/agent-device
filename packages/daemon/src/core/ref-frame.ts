import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { DaemonResponseData } from '@agent-device/kernel/contracts';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import {
  expiredRefFrame,
  issuedRefFrame,
  PRISTINE_REF_FRAME,
  type RefFrame,
  type RefFrameScope,
  type RefFrameState,
} from './ref-frame-slot.ts';
import type { SessionState } from './session-state.ts';
import { retireMovingTargetBaseline } from './deferred-interaction-outcome.ts';

const runtimeRevisions = new WeakMap<SessionState, number>();
const outdatedObservations = new WeakSet<SnapshotState>();

/**
 * ADR 0014 session ref-frame lifetime — the authorization model for mutation
 * refs, kept distinct from the latest operational observation (`session.snapshot`).
 *
 * A session owns at most one **ref frame**: the namespace whose refs a caller
 * may use to target a mutation. This module is the single owner of the frame's
 * transitions and of the admission decision; the frame value itself is declared in
 * `ref-frame-slot.ts`, below this module and the session record. The frame epoch reuses
 * the existing `snapshotGeneration`/`refsGeneration` counter and the `@e12~s42` pin grammar
 * for wire compatibility.
 *
 * The frame is expired at the device side-effect seam, carries a non-`all`
 * issuance scope after a partial publication, and its admission matrix is
 * enforced fail-closed on every platform before dispatch (ADR 0014, "Mutation admission and read behavior").
 * Read-only ref staleness comes from frame state instead of a coarse client-stale marker.
 * An expired frame warns for any ref; an active frame warns only when a pinned ref's
 * generation differs from the frame epoch (execution/session-snapshot.ts,
 * `resolveRefStalenessWarning`).
 */

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
 * The session's current frame, as one comparable value. Identity changes on
 * every transition and only on a transition, so a caller holding an earlier
 * frame can tell whether authority moved with a single `===`.
 */
export function refFrame(session: SessionState): RefFrame {
  return session.refFrame ?? PRISTINE_REF_FRAME;
}

/**
 * The frame epoch exposed to clients as `refsGeneration`. Frozen at issuance so
 * a later read-only capture that advances the observation counter
 * (`snapshotGeneration`) does not shift the epoch a valid pin is compared
 * against. Falls back to `snapshotGeneration` for pre-frame sessions.
 */
export function refFrameEpoch(session: SessionState): number | undefined {
  return refFrame(session).generation ?? session.snapshotGeneration;
}

/**
 * The tree that minted the frame's refs, retained so a ref resolves to the node
 * the caller was authorized against rather than to whatever now sits at that
 * index in a newer observation. Undefined before any issuance.
 */
export function refFrameTree(session: SessionState): SnapshotState | undefined {
  return refFrame(session).tree;
}

/**
 * Expire the current frame at a device side-effect seam (ADR 0014). The frame
 * transition is idempotent by identity: an effect crossed while already expired
 * leaves the SAME frame in place (the runtime revision below still advances, one
 * per effect, because that is what tracks effects). Call this SYNCHRONOUSLY,
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
  const previousFrame = refFrame(session);
  advanceSessionRuntimeRevision(session);
  markSessionSnapshotOutdated(session);
  session.refFrame = expiredRefFrame(refFrame(session));
  session.snapshotScopeSource = undefined;
  // The snapshot-per-action advisory counts this seam as its one mutation event per
  // logical command, so its rhythm keeps step with the lifetime contract. The frame
  // was replaced above, so the counters rekey onto the frame the session holds now.
  recordRefFrameAdvisoryMutation(previousFrame, refFrame(session));
  // #3471: a side effect no resolved target was aimed through leaves a tree predating an unmeasured
  // change, so it cannot screen a later press.
  retireMovingTargetBaseline(session);
}

/**
 * Record that the device was observed or changed after the session's stored tree was
 * captured: a side-effect seam above, or a native read that produces no tree (such as `wait
 * text`'s owner text reading). An outdated tree stays the session's latest stored observation,
 * but a selector read never reuses it in place of a capture.
 */
export function markSessionSnapshotOutdated(session: SessionState): void {
  if (session.snapshot) outdatedObservations.add(session.snapshot);
}

export function isOutdatedObservation(snapshot: SnapshotState): boolean {
  return outdatedObservations.has(snapshot);
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
  const previousFrame = refFrame(session);
  activateRefFrame(session, 'all');
  // The only complete-namespace publication: the advisory observes it as the other
  // half of its snapshot-per-action rhythm. The frame was replaced above, so the
  // counters rekey onto the frame the session holds now.
  recordRefFrameAdvisoryCompleteSnapshot(previousFrame, refFrame(session));
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
  const previousFrame = refFrame(session);
  activateRefFrame(session, scope);
  // A partial publication between snapshots is neither a complete snapshot nor an
  // action, so the advisory rhythm carries across the replacement unchanged.
  carryRefFrameAdvisoryAcrossPublication(previousFrame, refFrame(session));
}

/**
 * Both issuance forms land here because they differ only in scope, and because the frame is
 * one value: an `active` state paired with a stale tree resolves refs against a namespace
 * nobody authorized, and a frame pinned to the wrong generation invalidates correct pins.
 *
 * Retains the just-published tree (`session.snapshot`) as the frame's immutable source by
 * SHARED reference — no deep copy (ADR 0014 performance). A later read-only capture advances
 * `session.snapshot` without disturbing this tree, so a ref keeps resolving against the
 * namespace that authorized it.
 */
function activateRefFrame(session: SessionState, scope: RefFrameScope): void {
  session.refFrame = issuedRefFrame({
    scope,
    tree: session.snapshot,
    generation: session.snapshotGeneration,
  });
}

export function refFrameState(session: SessionState): RefFrameState {
  return refFrame(session).state;
}

export function refFrameScope(session: SessionState): RefFrameScope {
  return refFrame(session).scope;
}

export type RefMutationFrame = {
  admission: RefFrameAdmission;
  scope: RefFrameScope;
  currentGeneration: number | undefined;
};

export function readRefMutationFrame(params: {
  session: SessionState;
  ref: string;
  mintedGeneration: number | undefined;
}): RefMutationFrame {
  const refBody = params.ref.startsWith('@') ? params.ref.slice(1) : params.ref;
  return {
    admission: admitRefMutation({
      session: params.session,
      refBody,
      mintedGeneration: params.mintedGeneration,
    }),
    scope: refFrameScope(params.session),
    currentGeneration: refFrameEpoch(params.session),
  };
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

/**
 * Ergonomics advisory for the ADR 0014 snapshot-per-action workflow: a caller that
 * re-captures a COMPLETE snapshot before every single action, because each action
 * expires the ref frame and plain refs then need a fresh complete publication.
 * Selectors (or a settled diff from `--settle`) act without any snapshot, so a
 * session stuck in this rhythm pays the dominant capture cost per action.
 *
 * The advisory is a hint on the snapshot response, never an error, and it owns no
 * frame semantics: it only OBSERVES the transitions `ref-frame.ts` already owns.
 * `expireRefFrame` reports a device side effect (one per logical command, so
 * `--count` series count once), `activateCompleteRefFrame` reports the only
 * complete-namespace publication, and a partial publication just carries the
 * counters across its frame replacement.
 *
 * The counters live in a daemon-private `WeakMap` keyed by the frame VALUE, the
 * same pattern as `ref-frame.ts`'s runtime revisions. A frame is replaced whole on
 * every transition, so each hook rekeys the counters onto the frame the session
 * holds next; the entry dies with the session's last frame. Nothing is ever keyed
 * under the shared pristine frame, so sessions that never issued refs share no
 * state. This keeps the counters out of `SessionState`, whose write claims R10
 * freezes.
 *
 * One full snapshot followed by exactly one mutation and another full snapshot is
 * one round. Any other gap between complete snapshots (no mutation, or two or more)
 * is not snapshot-per-action and resets the consecutive count. After
 * {@link ADVISORY_ROUNDS_THRESHOLD} consecutive rounds, the next complete-snapshot
 * response carries one hint line through the shared response-warnings channel
 * (`data.warnings`), which the CLI snapshot text renders as a notice via
 * `buildSnapshotNotices`.
 */
type RefFrameAdvisoryCounters = {
  /** Device side effects observed since the last complete-snapshot publication. */
  mutationsSinceSnapshot: number;
  /** Consecutive full-snapshot → single-mutation → full-snapshot rounds. */
  rounds: number;
  /** One-shot: the next complete-snapshot response must carry the hint. */
  pendingHint: boolean;
};

const ADVISORY_ROUNDS_THRESHOLD = 3;

const FRESH_ADVISORY: RefFrameAdvisoryCounters = {
  mutationsSinceSnapshot: 0,
  rounds: 0,
  pendingHint: false,
};

const advisoryByFrame = new WeakMap<RefFrame, RefFrameAdvisoryCounters>();

function readAdvisory(frame: RefFrame): RefFrameAdvisoryCounters {
  return advisoryByFrame.get(frame) ?? FRESH_ADVISORY;
}

/** Rekeys the counters onto the frame the session holds next; the replaced frame dies. */
function carryAdvisory(
  previous: RefFrame,
  current: RefFrame,
  counters: RefFrameAdvisoryCounters,
): void {
  advisoryByFrame.delete(previous);
  advisoryByFrame.set(current, counters);
}

/**
 * Called by `expireRefFrame` at each device side-effect seam, so the counter keeps
 * step with ADR 0014's definition of "the device may have acted". An already-expired
 * frame is returned as is by that seam, so repeated effects accumulate on the same
 * frame key.
 */
function recordRefFrameAdvisoryMutation(previous: RefFrame, current: RefFrame): void {
  const counters = readAdvisory(previous);
  carryAdvisory(previous, current, {
    ...counters,
    mutationsSinceSnapshot: counters.mutationsSinceSnapshot + 1,
  });
}

/**
 * Called by `activateCompleteRefFrame`, the only complete-namespace publication.
 * Exactly one mutation since the previous complete snapshot extends the rhythm; any
 * other gap resets it. A snapshot that reissues nothing (a `@`-scoped capture that
 * kept the stored tree) never reaches this hook, so it neither extends nor resets.
 */
function recordRefFrameAdvisoryCompleteSnapshot(previous: RefFrame, current: RefFrame): void {
  const counters = readAdvisory(previous);
  const rounds = counters.mutationsSinceSnapshot === 1 ? counters.rounds + 1 : 0;
  carryAdvisory(previous, current, {
    mutationsSinceSnapshot: 0,
    rounds,
    pendingHint: rounds >= ADVISORY_ROUNDS_THRESHOLD,
  });
}

/**
 * Called by a partial publication (`activatePartialRefFrame`): a `find` or settled
 * diff between snapshots is neither a complete snapshot nor an action, so the
 * rhythm carries across the frame replacement unchanged.
 */
function carryRefFrameAdvisoryAcrossPublication(previous: RefFrame, current: RefFrame): void {
  if (previous === current) return;
  carryAdvisory(previous, current, readAdvisory(previous));
}

/**
 * Consumes the one-shot flag on every user-facing snapshot/diff response, win or
 * lose, so a hint armed by a dispatch that later failed cannot leak onto an
 * unrelated response. Appends the hint line only on a complete-snapshot response,
 * where `buildSnapshotNotices` renders `data.warnings` as notices.
 */
export function applyRefFrameAdvisoryHint(params: {
  session: SessionState | undefined;
  data: DaemonResponseData;
  completeSnapshotResponse: boolean;
}): DaemonResponseData {
  const { session, data, completeSnapshotResponse } = params;
  if (!session) return data;
  // Read-only: the session's current frame, pristine before anything issued (the
  // same accessor `ref-frame.ts` exposes; imported there would be a cycle).
  const frame = session.refFrame ?? PRISTINE_REF_FRAME;
  const counters = advisoryByFrame.get(frame);
  if (!counters) return data;
  advisoryByFrame.set(frame, { ...counters, pendingHint: false });
  if (!completeSnapshotResponse || !counters.pendingHint) return data;
  return {
    ...data,
    warnings: [...readResponseWarnings(data), snapshotPerActionHint(counters.rounds)],
  };
}

function snapshotPerActionHint(rounds: number): string {
  return [
    `Hint: the last ${rounds} snapshots in a row each covered one action.`,
    'Every action expires the snapshot refs, so each action forced a fresh full snapshot.',
    'Target the action with a selector (id, label, role, or text), or run it with --settle and continue from its diff, to act without a new snapshot.',
  ].join(' ');
}
