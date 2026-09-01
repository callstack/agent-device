import type { CommandFlags } from '@agent-device/contracts/command';
import type { SessionState } from './types.ts';
import {
  NO_SCRIPT_PUBLICATION,
  abortAuthoring,
  armAuthoring,
  armRepair,
  isAuthoringAborted,
  isRecordingPublication,
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

function publicationState(session: SessionState | undefined) {
  return session?.scriptPublication ?? NO_SCRIPT_PUBLICATION;
}

/**
 * An ordinary authoring session still open to recording: the ADR 0016 lifecycle before it aborts
 * or publishes. The authoring counterpart of `isRepairArmedSession`, and the one shape the
 * handlers ask about — a second `open` aborts it, `close --save-script` may still publish it, and
 * active publication is eligible only from it.
 */
export function isAuthoringArmedSession(session: SessionState | undefined): boolean {
  const state = publicationState(session);
  return state.kind === 'authoring' && state.status === 'armed';
}

/** ADR 0016: `open <app> --save-script[=<path>]` on a fresh session arms ordinary authoring. */
export function armAuthoringOnOpen(
  session: SessionState,
  requested: { path?: string; force?: boolean },
): void {
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
  session.scriptPublication = abortAuthoring(publicationState(session));
}

/**
 * Whether the session captures recording-time evidence (`isRecordingPublication`).
 *
 * The one question every recording-sensitive site asks, answered from the aggregate rather than
 * from a boolean kept in step with it by hand. No surface can arm recording without moving the
 * lifecycle that authorizes it, which is what makes #1533's drift unrepresentable rather than
 * merely guarded against.
 */
export function isSessionRecording(session: SessionState | undefined): boolean {
  return isRecordingPublication(publicationState(session));
}

/**
 * The shared `--save-script` ingress on a RECORDED action (`open`/`close`; #1501 pins every
 * other command's raw flag closed at the router). Arms recording and applies target/force to
 * whichever lifecycle the session is in:
 *
 * - `none` -> ordinary authoring armed. This branch is UNREACHABLE for `close`: live evidence
 *   (2026-08-02) showed it used to let a never-armed `close --save-script` fold into the
 *   authoring lifecycle and publish moments later in the same request — a script with selector
 *   fallback chains but no recording-time `target-v1` evidence, and no signal to the caller.
 *   `session-lifecycle/internal/session-close.ts`'s `assertTerminalRecordingCloseAllowed` now
 *   rejects an unarmed `close --save-script` before any action recording runs, so this arm only
 *   fires for a future non-close caller of the shared ingress; it is kept as that caller's safety
 *   net, not as a documented close-time behavior.
 * - `authoring` -> retarget under the #1258 per-target force rule (`resolveScriptTarget`).
 * - `repair` -> retarget the repair target the same way (a replayed step may carry the flag).
 *
 * - `authoring{aborted}` -> nothing. The lifecycle is terminal (#1533), so the flag neither
 *   re-arms recording nor retargets: recording-time evidence stopped at the abort.
 */
export function applyRecordedSaveScriptFlags(session: SessionState, flags: CommandFlags): void {
  if (!flags.saveScript) return;
  if (isAuthoringAborted(publicationState(session))) return;
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

/** Active publication succeeded: PUBLISHED is terminal, which is what stops recording. */
export function markActivePublicationDone(session: SessionState, writtenPath: string): void {
  session.scriptPublication = markAuthoringPublished(publicationState(session), writtenPath);
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
