import type { CommandFlags } from '@agent-device/contracts/command';
import type { SessionState } from './types.ts';
import {
  NO_SCRIPT_PUBLICATION,
  abortAuthoring,
  armAuthoring,
  armRepair,
  isScriptPublished,
  markAuthoringPublished,
  resolveScriptTarget,
  scriptTargetForce,
} from './session-script-publication-state.ts';
import { expandSessionPath } from './session-paths.ts';

/**
 * `SessionScriptPublication` (#1478 P4a): the daemon-private projection owning every supported
 * ordinary-authoring write — arming on `open`, the shared `--save-script` flag ingress on
 * recorded actions, active publication (`session save-script`), and the published transition.
 * Repair transitions live in `session-replay-transaction.ts`; the two variants stay disjoint by
 * construction of the aggregate. Engines can reach neither.
 */

function publicationState(session: SessionState) {
  return session.scriptPublication ?? NO_SCRIPT_PUBLICATION;
}

/** ADR 0016: `open <app> --save-script[=<path>]` on a fresh session arms ordinary authoring. */
export function armAuthoringOnOpen(
  session: SessionState,
  requested: { path?: string; force?: boolean },
): void {
  session.recordSession = true;
  session.scriptPublication = armAuthoring({
    path: requested.path !== undefined ? expandSessionPath(requested.path) : undefined,
    force: requested.force === true,
  });
}

/**
 * ADR 0016: a second successful `open` on an armed authoring session terminates the recording —
 * the journey no longer starts where the script says it does.
 */
export function abortAuthoringOnSecondOpen(session: SessionState): void {
  session.recordSession = false;
  session.scriptPublication = abortAuthoring(publicationState(session));
}

/**
 * The shared `--save-script` ingress on a RECORDED action (`open`/`close`; #1501 pins every
 * other command's raw flag closed at the router). Arms recording and applies target/force to
 * whichever lifecycle the session is in:
 *
 * - `none` -> ordinary authoring armed. This is how a never-armed `close --save-script`
 *   publishes the whole log: the close request arms at record time and publishes moments later
 *   in the same request, folding the former "third mode" into the authoring lifecycle. The
 *   session is deleted by every close path that gets this far, so the transient armed state is
 *   unobservable to `session save-script` eligibility.
 * - `authoring` -> retarget under the #1258 per-target force rule (`resolveScriptTarget`).
 * - `repair` -> retarget the repair target the same way (a replayed step may carry the flag).
 */
export function applyRecordedSaveScriptFlags(session: SessionState, flags: CommandFlags): void {
  if (!flags.saveScript) return;
  session.recordSession = true;
  const requested = {
    path: typeof flags.saveScript === 'string' ? expandSessionPath(flags.saveScript) : undefined,
    force: flags.force === true,
  };
  const state = publicationState(session);
  if (state.kind === 'repair') {
    session.scriptPublication = armRepair(state, {
      requested,
      boundary: state.boundary,
      sourcePath: state.sourcePath,
    });
    return;
  }
  if (state.kind === 'authoring') {
    session.scriptPublication = {
      ...state,
      target: resolveScriptTarget(state.target, requested),
    };
    return;
  }
  session.scriptPublication = armAuthoring(requested);
}

/**
 * Retarget for active publication (`session save-script <path>`), same #1258 rule; a live
 * `--force` re-grants for the (possibly new) target.
 */
export function retargetActivePublication(
  session: SessionState,
  params: { explicitPath?: string; liveForce: boolean | undefined },
): void {
  const state = publicationState(session);
  if (state.kind !== 'authoring') return;
  session.scriptPublication = {
    ...state,
    target: resolveScriptTarget(state.target, {
      path: params.explicitPath !== undefined ? expandSessionPath(params.explicitPath) : undefined,
      force: params.liveForce === true,
    }),
  };
}

/** Active publication succeeded: record the written path and stop recording (ADR 0016). */
export function markActivePublicationDone(session: SessionState, writtenPath: string): void {
  session.scriptPublication = markAuthoringPublished(publicationState(session), writtenPath);
  session.recordSession = false;
}

/** Ordinary close publication succeeded: the authoring lifecycle reached `published`. */
export function markCloseGeneratedPublicationDone(
  session: SessionState,
  writtenPath: string,
): void {
  const state = publicationState(session);
  if (state.kind !== 'authoring') return;
  session.scriptPublication = markAuthoringPublished(state, writtenPath);
}

/**
 * The effective overwrite decision at a write site (#1258): a live `--force` on this request, or
 * the per-target grant persisted at arm time.
 */
export function effectiveWriteForce(
  session: SessionState,
  liveForce: boolean | undefined,
): boolean {
  return liveForce === true || scriptTargetForce(publicationState(session));
}

/** A committed/published session's second write must no-op rather than republish. */
export function isSessionScriptPublished(session: SessionState): boolean {
  return isScriptPublished(publicationState(session));
}
