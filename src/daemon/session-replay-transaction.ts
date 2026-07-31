import type { SessionState } from './types.ts';
import {
  NO_SCRIPT_PUBLICATION,
  abortRepair,
  armRepair,
  demoteRepairToArmed,
  isUncommittedRepair,
  markRepairComplete,
  recordRepairCloseSucceeded,
  repairBoundary,
  repairSourcePath,
} from './session-script-publication-state.ts';
import { expandSessionPath } from './session-paths.ts';

/**
 * `ReplaySessionTransaction` (#1478 P4a): the daemon-private projection through which the ADR
 * 0012 decision 6 repair lifecycle is written. Handlers arm, complete, demote, and stamp close
 * receipts here; nothing else assigns the repair variant. Reads stay on the pure helpers in
 * `session-script-publication-state.ts`. Engines can reach neither.
 *
 * #1478 P4b: a native `.ad` replay request no longer imports this module directly — it reaches
 * every operation here through `session-replay-coordinator.ts`'s `ReplayCoordinator`, the one
 * locked gateway for that request's repair transaction. Close-time sequencing
 * (`session-close.ts`'s platform-close receipt and repair-armed check,
 * `session-close-script.ts`'s commit/abort) is a different capability — commit/abort happen at
 * teardown, ordered against platform close and lease release, not during a replay request — and
 * remains a direct caller by design. `session-store.ts`, `session-action-recorder.ts`,
 * `session-script-writer.ts`, and `server/daemon-idle-reap.ts` also stay direct callers of the
 * read-only projections (`isRepairArmedSession`, `repairSessionBoundary`,
 * `isUncommittedRepairSession`, `repairSessionSourcePath`): those sites span session lifecycle
 * concerns outside any single locked replay request, so routing them through a per-request
 * coordinator would add indirection without a lifecycle-safety benefit.
 */

function publicationState(session: SessionState | undefined) {
  return session?.scriptPublication ?? NO_SCRIPT_PUBLICATION;
}

/**
 * ADR 0012 decision 6, R1/R6: arms recording on the CURRENT session and records the boundary
 * watermark once. `firstArm` captures the pre-run action count on the pre-loop session, so a
 * reused session's earlier actions stay excluded; a LATER arm reaching a repair-less session
 * means step-1 `open` REPLACED it with a fresh `actions: []`, so the boundary is 0, keeping the
 * healed `open` in the slice. An explicit `<out>` always wins; absent one, the healed script
 * defaults to the `<original-stem>.healed.ad` sibling (R6), materialized as an explicit target.
 *
 * #1258: a LIVE `--force` persists into the target authorization so a later `--from`
 * continuation leg or an unattended auto-commit teardown still honors it; an explicit retarget
 * without live force drops the previous target's grant (`resolveScriptTarget`).
 */
export function armRepairStep(
  session: SessionState,
  params: {
    saveScript: boolean | string;
    force: boolean | undefined;
    sourcePath: string;
    healedSiblingPath: string;
    firstArm: boolean;
  },
): void {
  session.recordSession = true;
  const state = publicationState(session);
  const explicitPath =
    typeof params.saveScript === 'string'
      ? expandSessionPath(params.saveScript)
      : state.kind === 'repair'
        ? undefined
        : params.healedSiblingPath;
  session.scriptPublication = armRepair(state, {
    requested: { path: explicitPath, force: params.force === true },
    boundary: params.firstArm ? session.actions.length : 0,
    sourcePath: params.sourcePath,
  });
}

/**
 * A `replay --from` continuation re-runs the plan, so completion is no longer proven; the close
 * receipt survives the demotion (see `demoteRepairToArmed`).
 */
export function resetRepairCompletionForRerun(session: SessionState): void {
  session.scriptPublication = demoteRepairToArmed(publicationState(session));
}

/** The plan reached its final executable step with no outstanding divergence (C2). */
export function markRepairTransactionComplete(session: SessionState): void {
  session.scriptPublication = markRepairComplete(publicationState(session));
}

/** The platform close for `operationIdentity` succeeded; retries with the same identity skip dispatch. */
export function recordRepairPlatformClose(session: SessionState, operationIdentity: string): void {
  session.scriptPublication = recordRepairCloseSucceeded(
    publicationState(session),
    operationIdentity,
  );
}

/**
 * Terminal failure: the transaction never completed, so a close/teardown that reaches it
 * publishes nothing, forever. Receipt cleanup is part of terminality (`abortRepair`).
 */
export function abortRepairTransaction(session: SessionState): void {
  session.scriptPublication = abortRepair(publicationState(session));
}

/** Whether the platform close for `operationIdentity` already succeeded for this transaction. */
export function hasRepairPlatformCloseReceipt(
  session: SessionState,
  operationIdentity: string,
): boolean {
  const state = publicationState(session);
  return state.kind === 'repair' && state.closeReceipt === operationIdentity;
}

/** Whether this session carries a repair transaction at all (any status). */
export function isRepairArmedSession(session: SessionState | undefined): boolean {
  return publicationState(session).kind === 'repair';
}

/** Uncommitted repair: held on divergence, reapable, and tombstoned on teardown. */
export function isUncommittedRepairSession(session: SessionState | undefined): boolean {
  return isUncommittedRepair(publicationState(session));
}

/** The repair watermark (R6), or `undefined` when the session is not under repair. */
export function repairSessionBoundary(session: SessionState | undefined): number | undefined {
  return repairBoundary(publicationState(session));
}

/** The original replay input path for reap tombstones (C5a). */
export function repairSessionSourcePath(session: SessionState | undefined): string | undefined {
  return repairSourcePath(publicationState(session));
}
