/**
 * The tagged script-publication aggregate (#1478 P4a): `SessionState.scriptPublication`.
 *
 * One state machine holds both publication lifecycles and their shared output target: the ADR
 * 0016 ordinary authoring lifecycle, the ADR 0012 decision 6 repair transaction, and the
 * per-target force authorization (#1258). The disjointness of the two lifecycles is structural —
 * a session publishes nothing, authors ordinarily, or is under repair — so no reader re-derives
 * it from field combinations and no writer clears siblings.
 *
 * Values and pure transitions only; no authority. Writes go through the daemon-private
 * projections (`session-replay-transaction.ts`, `session-script-publication-capability.ts`) and
 * the writer's commit transition — the R7 ownership gate enforces exactly that set — and no
 * engine can reach any of them.
 */

/**
 * Where a script publishes.
 *
 * `default` is not an absence — it is the state produced by a bare `open --save-script`, which
 * arms authoring with no path and lets the writer resolve a daemon-owned
 * `sessions/<name>-<timestamp>.ad` destination at write time. Modelling it as a variant rather
 * than an undefined path is what keeps the retarget rule below expressible.
 */
export type SessionScriptTarget =
  | Readonly<{ kind: 'default'; force: boolean }>
  | Readonly<{ kind: 'explicit'; path: string; force: boolean }>;

/**
 * ADR 0012 decision 6 repair status.
 *
 * The success path is armed -> complete -> close-succeeded -> committed, and `aborted` is
 * terminal. It is NOT a linear-only relation: `complete` can regress to `armed` when a
 * `replay --from` continues a repair whose commit failed, and the close receipt survives that
 * regression (see `demoteRepairToArmed`).
 */
export type SessionScriptRepairStatus =
  | 'armed'
  | 'complete'
  | 'close-succeeded'
  | 'committed'
  | 'aborted';

export type SessionScriptPublicationState =
  | Readonly<{ kind: 'none' }>
  /** ADR 0016 ordinary open-to-destination authoring. Disjoint from repair by construction. */
  | Readonly<{
      kind: 'authoring';
      status: 'armed' | 'aborted' | 'published';
      target: SessionScriptTarget;
    }>
  | Readonly<{
      kind: 'repair';
      status: SessionScriptRepairStatus;
      target: SessionScriptTarget;
      /**
       * `session.actions.length` when `replay --save-script` armed this session. The healed
       * `.ad` serializes only actions from this index onward, so a reused session's earlier,
       * unrelated actions never leak into the healed script (R6).
       */
      boundary: number;
      /**
       * The original replay input path, stashed so an idle-reap tombstone can hand the agent an
       * actionable `replay <path> --save-script` re-run instead of a bare SESSION_NOT_FOUND
       * (C5a).
       */
      sourcePath?: string;
      /**
       * Identity of the platform-close operation that succeeded, so a publication retry for the
       * SAME operation skips close dispatch while a different identity dispatches afresh.
       *
       * Retained across status regressions — a failed commit followed by a `replay --from`
       * demotes completion but must NOT drop the receipt, or the retry re-dispatches a close
       * that already succeeded. Only terminal lifecycle cleanup clears it.
       */
      closeReceipt?: string;
    }>;

export const NO_SCRIPT_PUBLICATION: SessionScriptPublicationState = { kind: 'none' };

/**
 * Applies an arming request, honoring per-target force authorization (#1258).
 *
 * `--force` is a per-target grant, not a session-wide one: re-arming a DIFFERENT explicit target
 * without a live `--force` must clear it, so a later retarget cannot silently overwrite a file
 * the caller never opted into. Because authorization is a field of the target, replacing the
 * target replaces its authorization — there is no separate flag left behind to forget.
 *
 * Two retentions are deliberate:
 *
 * - re-arming the SAME explicit path keeps an existing grant; a bare re-arm is not a withdrawal;
 * - moving from `default` to an explicit path keeps it, so `open --save-script --force`
 *   followed by `close --save-script=out.ad` is not treated as a retarget and the grant
 *   survives.
 *
 * That second case is arguably a #1258 gap — the caller authorized overwriting an unnamed
 * default, not `out.ad`. It is preserved here so the migration changes no behavior; tightening
 * it is a deliberate product change and belongs in its own commit, not smuggled into a refactor.
 */
export function resolveScriptTarget(
  previous: SessionScriptTarget | undefined,
  requested: Readonly<{ path?: string | undefined; force: boolean }>,
): SessionScriptTarget {
  if (requested.path === undefined) {
    // A bare re-arm is not a retarget: the previous target — explicit path included — survives
    // untouched, gaining a live force grant if one accompanies the re-arm. This is what keeps a
    // per-step repair armer or a repeated `--save-script` from wiping the materialized healed
    // sibling back to the daemon default.
    const base = previous ?? { kind: 'default', force: false };
    return requested.force ? { ...base, force: true } : base;
  }
  const retainsAuthorization =
    previous?.force === true && (previous.kind === 'default' || previous.path === requested.path);
  return { kind: 'explicit', path: requested.path, force: requested.force || retainsAuthorization };
}

/**
 * Continues a repair whose commit failed, after a `replay --from` re-runs the plan.
 *
 * Completion is demoted because the plan must reach its final executable step again, but the
 * close receipt is retained: the platform close already succeeded for that operation identity,
 * and dropping it would re-dispatch a close on the eventual retry.
 */
export function demoteRepairToArmed(
  state: SessionScriptPublicationState,
): SessionScriptPublicationState {
  if (state.kind !== 'repair') return state;
  return { ...state, status: 'armed' };
}

/** The target a state publishes to, or `undefined` when it publishes nothing. */
function scriptPublicationTarget(
  state: SessionScriptPublicationState,
): SessionScriptTarget | undefined {
  return state.kind === 'none' ? undefined : state.target;
}

/**
 * Whether a repair transaction has reached its final executable step with no outstanding
 * divergence, which is what gates commit (C2). `close-succeeded` is a sub-state of complete —
 * every existing commit gate keys off completeness, and the dispatch-skip decision keys off
 * receipt identity rather than status, so no caller needs to distinguish them.
 */
export function isRepairCommittable(state: SessionScriptPublicationState): boolean {
  return (
    state.kind === 'repair' && (state.status === 'complete' || state.status === 'close-succeeded')
  );
}

/**
 * #1533: terminal authoring failure — a second successful `open` ended the journey, so the
 * recording publishes NOTHING, forever. The authoring counterpart of an aborted repair, and
 * terminal in the same sense: the state itself answers the question, so no caller re-derives
 * terminality from a separate flag.
 */
export function isAuthoringAborted(state: SessionScriptPublicationState): boolean {
  return state.kind === 'authoring' && state.status === 'aborted';
}

/**
 * Whether the session captures recording-time evidence: portable selector chains and ADR 0012
 * `target-v1` identity, gathered at action time because they cannot be reconstructed later.
 *
 * This is what `SessionState.recordSession` used to store alongside the aggregate. The boolean
 * was redundant — every writer set both — but nothing made them agree, which is how #1533
 * happened: a `--save-script` ingress re-armed the flag behind an ABORTED status. Deriving the
 * answer removes the second source of truth rather than policing it.
 *
 * Evidence capture is not free: it disables the direct-selector fast paths for `click` and `get`
 * (a captured resolution tree is required to compute evidence), so the predicate must stay exact
 * rather than merely safe.
 *
 * - `authoring` records only while ARMED. ABORTED and PUBLISHED are terminal, and the journey is
 *   over in both.
 * - `repair` records for its whole lifetime, terminal statuses included. That mirrors the
 *   previous flag exactly: `armRepairStep` set it, and neither `abortRepair` nor `commitRepair`
 *   ever cleared it. Whether a committed repair should still capture evidence is a real question,
 *   but it is a behavior change and does not belong in the derivation.
 */
export function isRecordingPublication(state: SessionScriptPublicationState): boolean {
  if (state.kind === 'authoring') return state.status === 'armed';
  return state.kind === 'repair';
}

/** A committed publication is idempotent: a second write no-ops rather than republishing. */
export function isScriptPublished(state: SessionScriptPublicationState): boolean {
  if (state.kind === 'repair') return state.status === 'committed';
  return state.kind === 'authoring' && state.status === 'published';
}

/** ADR 0016: `open --save-script` on a fresh session arms ordinary authoring. */
export function armAuthoring(
  requested: Readonly<{ path?: string | undefined; force: boolean }>,
): SessionScriptPublicationState {
  return { kind: 'authoring', status: 'armed', target: resolveScriptTarget(undefined, requested) };
}

/**
 * ADR 0016: a second successful `open` on an armed authoring session terminates the recording —
 * the journey no longer starts where the script says it does. Any other state passes through.
 */
export function abortAuthoring(
  state: SessionScriptPublicationState,
): SessionScriptPublicationState {
  if (state.kind !== 'authoring' || state.status !== 'armed') return state;
  return { ...state, status: 'aborted' };
}

/** Active publication succeeded; the written path becomes the explicit target. */
export function markAuthoringPublished(
  state: SessionScriptPublicationState,
  writtenPath: string,
): SessionScriptPublicationState {
  if (state.kind !== 'authoring') return state;
  return {
    kind: 'authoring',
    status: 'published',
    target: { kind: 'explicit', path: writtenPath, force: state.target.force },
  };
}

/**
 * ADR 0012 decision 6, R1/R6: `replay --save-script` arms (or re-arms, per step) the repair
 * transaction. The boundary and source path stamp once — later arms of the same run retarget and
 * re-authorize but never move the watermark or forget the original input.
 */
export function armRepair(
  state: SessionScriptPublicationState,
  params: Readonly<{
    requested: Readonly<{ path?: string | undefined; force: boolean }>;
    boundary: number;
    sourcePath?: string | undefined;
  }>,
): SessionScriptPublicationState {
  const previous = state.kind === 'repair' ? state : undefined;
  const sourcePath = previous?.sourcePath ?? params.sourcePath;
  return {
    kind: 'repair',
    status: previous?.status ?? 'armed',
    target: resolveScriptTarget(previous?.target, params.requested),
    boundary: previous?.boundary ?? params.boundary,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(previous?.closeReceipt !== undefined ? { closeReceipt: previous.closeReceipt } : {}),
  };
}

/** The plan reached its final executable step with no outstanding divergence (C2). */
export function markRepairComplete(
  state: SessionScriptPublicationState,
): SessionScriptPublicationState {
  if (state.kind !== 'repair' || state.status !== 'armed') return state;
  return { ...state, status: 'complete' };
}

/**
 * The platform close for `operationIdentity` succeeded. `close-succeeded` is only reachable from
 * completeness; an incomplete repair's close still records the receipt so a retry after a failed
 * commit does not re-dispatch, which is the receipt's whole job.
 */
export function recordRepairCloseSucceeded(
  state: SessionScriptPublicationState,
  operationIdentity: string,
): SessionScriptPublicationState {
  if (state.kind !== 'repair') return state;
  return {
    ...state,
    status: state.status === 'complete' ? 'close-succeeded' : state.status,
    closeReceipt: operationIdentity,
  };
}

/** Terminal success: the healed script is on disk. Receipt cleanup is part of terminality. */
export function commitRepair(state: SessionScriptPublicationState): SessionScriptPublicationState {
  if (state.kind !== 'repair') return state;
  const { closeReceipt: _closeReceipt, ...rest } = state;
  return { ...rest, status: 'committed' };
}

/** Terminal failure: the transaction never completed, so publication is refused forever. */
export function abortRepair(state: SessionScriptPublicationState): SessionScriptPublicationState {
  if (state.kind !== 'repair') return state;
  const { closeReceipt: _closeReceipt, ...rest } = state;
  return { ...rest, status: 'aborted' };
}

/** The repair watermark (R6), or `undefined` when the session is not under repair. */
export function repairBoundary(state: SessionScriptPublicationState): number | undefined {
  return state.kind === 'repair' ? state.boundary : undefined;
}

/** The original `replay` input path stashed for reap tombstones (C5a). */
export function repairSourcePath(state: SessionScriptPublicationState): string | undefined {
  return state.kind === 'repair' ? state.sourcePath : undefined;
}

/**
 * An uncommitted repair transaction — the state that blocks nothing (idle-reap proceeds) but
 * demands a tombstone when torn down. Aborted repairs still qualify: they hold a boundary and
 * never committed, exactly the sessions R7's expiry tombstone exists for.
 */
export function isUncommittedRepair(state: SessionScriptPublicationState): boolean {
  return state.kind === 'repair' && state.status !== 'committed';
}

/** The explicit output path, or `undefined` for none/default (writer resolves its own). */
export function scriptTargetPath(state: SessionScriptPublicationState): string | undefined {
  const target = scriptPublicationTarget(state);
  return target?.kind === 'explicit' ? target.path : undefined;
}

/** The persisted per-target overwrite authorization (#1258). */
export function scriptTargetForce(state: SessionScriptPublicationState): boolean {
  return scriptPublicationTarget(state)?.force === true;
}
