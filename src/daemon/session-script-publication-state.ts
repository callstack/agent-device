/**
 * The tagged script-publication aggregate (#1478 P4a).
 *
 * Nine co-resident optional fields on `SessionState` encode two lifecycles plus a shared output
 * target: `scriptRecordingState` (the ADR 0016 ordinary authoring lifecycle), the ADR 0012
 * decision 6 repair transaction (`saveScriptBoundary`, `saveScriptComplete`,
 * `saveScriptCommitted`, `repairPlatformCloseReceipt`, `repairSourcePath`), and the target
 * itself (`saveScriptPath`, `saveScriptForce`).
 *
 * Nothing in that shape says the two lifecycles are disjoint, so every reader re-derived it from
 * field combinations and every writer had to remember which siblings to clear. This aggregate
 * makes the disjointness structural: a session is publishing nothing, authoring ordinarily, or
 * under repair.
 *
 * Values and pure transitions only; no authority. The capability that performs close sequencing
 * and atomic publication is separate, and no engine can reach either.
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
 * Two retentions are deliberate, and both reproduce today's `applySaveScriptRetarget`:
 *
 * - re-arming the SAME explicit path keeps an existing grant; a bare re-arm is not a withdrawal;
 * - moving from `default` to an explicit path keeps it. Today's retarget check requires a
 *   previously PERSISTED path, so `open --save-script --force` followed by
 *   `close --save-script=out.ad` is not treated as a retarget and the grant survives.
 *
 * That second case is arguably a #1258 gap — the caller authorized overwriting an unnamed
 * default, not `out.ad`. It is preserved here so the migration changes no behavior; tightening
 * it is a deliberate product change and belongs in its own commit, not smuggled into a refactor.
 */
export function resolveScriptTarget(
  previous: SessionScriptTarget | undefined,
  requested: Readonly<{ path?: string; force: boolean }>,
): SessionScriptTarget {
  const retainsAuthorization =
    previous?.force === true &&
    (previous.kind === 'default' ||
      previous.path === requested.path ||
      requested.path === undefined);
  const force = requested.force || retainsAuthorization;
  return requested.path === undefined
    ? { kind: 'default', force }
    : { kind: 'explicit', path: requested.path, force };
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
export function scriptPublicationTarget(
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

/** A committed publication is idempotent: a second write no-ops rather than republishing. */
export function isScriptPublished(state: SessionScriptPublicationState): boolean {
  if (state.kind === 'repair') return state.status === 'committed';
  return state.kind === 'authoring' && state.status === 'published';
}
