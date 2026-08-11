import fs from 'node:fs';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import { expandSessionPath } from '../session-paths.ts';
import { errorResponse, noActiveSessionError } from './response.ts';
import {
  NO_SCRIPT_PUBLICATION,
  scriptTargetForce,
  scriptTargetPath,
  type SessionScriptPublicationState,
} from '../session-script-publication-state.ts';
import { healedScriptSiblingPath, type ReplayCoordinator } from '../session-replay-coordinator.ts';

/**
 * #1555 P5 (decomposition): `runReplayScriptFile`'s (`session-replay-runtime.ts`) session
 * preparation — the repair-preflight/resume-consumption/save-script-arming work that runs after
 * `prepareReplayPlan` (`session-replay-runtime-plan.ts`) accepts a plan but before the engine step
 * loop dispatches step 1. Extracted verbatim. `prepareReplaySession` is the one entry point;
 * everything else here is its own private decomposition (R2's repair-preflight, R6's arm-time
 * EEXIST preflight, and the actual arming closure).
 */

export function prepareReplaySession(params: {
  req: DaemonRequest;
  entryIndex: number;
  sessionStore: SessionStore;
  sessionName: string;
  sourcePath: string;
  coordinator: ReplayCoordinator;
}): { ok: true; armSaveScript: () => void } | { ok: false; response: DaemonResponse } {
  const { req, entryIndex, sessionStore, sessionName, sourcePath, coordinator } = params;
  const sessionPreflight = validateReplaySessionEntry({
    entryIndex,
    sessionStore,
    sessionName,
    coordinator,
  });
  if (sessionPreflight) return { ok: false, response: sessionPreflight };

  consumeReplayResumeState({ req, coordinator });
  return prepareSaveScriptSession({ req, sessionStore, sessionName, sourcePath, coordinator });
}

function validateReplaySessionEntry(params: {
  entryIndex: number;
  sessionStore: SessionStore;
  sessionName: string;
  coordinator: ReplayCoordinator;
}): DaemonResponse | undefined {
  const repairPreflight = preflightReplayAgainstActiveRepair(params);
  if (repairPreflight) return repairPreflight;
  if (params.entryIndex > 0 && !params.sessionStore.get(params.sessionName)) {
    return noActiveSessionError();
  }
  return undefined;
}

/**
 * Rejects arming a repair over an ordinary authoring recording (R2's disjointness) and runs the
 * arm-time EEXIST preflight against the target this request resolves to.
 */
function rejectSaveScriptArming(params: {
  saveScript: boolean | string | undefined;
  force: boolean | undefined;
  preRunState: SessionScriptPublicationState;
  sourcePath: string;
}): DaemonResponse | undefined {
  const { saveScript, force, preRunState, sourcePath } = params;
  if (saveScript && preRunState.kind === 'authoring') {
    return errorResponse(
      'INVALID_ARGS',
      `replay --save-script cannot re-arm an ordinary recording in terminal/active state ${preRunState.status}. Close this session and use a fresh one for repair authoring.`,
    );
  }
  return preflightSaveScriptTarget({
    saveScript,
    liveForce: force,
    persistedForce: scriptTargetForce(preRunState) || undefined,
    sourcePath,
    existingSaveScriptPath: scriptTargetPath(preRunState),
  });
}

function prepareSaveScriptSession(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  sessionName: string;
  sourcePath: string;
  coordinator: ReplayCoordinator;
}): { ok: true; armSaveScript: () => void } | { ok: false; response: DaemonResponse } {
  const { req, sessionStore, sessionName, sourcePath, coordinator } = params;
  const preRunSession = sessionStore.get(sessionName);
  const { saveScript, force } = req.flags ?? {};
  const rejection = rejectSaveScriptArming({
    saveScript,
    force,
    preRunState: preRunSession?.scriptPublication ?? NO_SCRIPT_PUBLICATION,
    sourcePath,
  });
  if (rejection) return { ok: false, response: rejection };

  coordinator.demoteForRerunIfArmed();
  return {
    ok: true,
    armSaveScript: createReplaySaveScriptArmer({
      saveScript,
      force,
      coordinator,
      sourcePath,
    }),
  };
}

function consumeReplayResumeState(params: {
  req: DaemonRequest;
  coordinator: ReplayCoordinator;
}): void {
  const { req, coordinator } = params;
  coordinator.clearCorrectiveWatermarkIfExpected(req.flags?.replayFrom);
  if (req.flags?.saveScript) coordinator.clearTombstone();
}

/**
 * ADR 0012 decision 6, R2: reject a fresh FULL replay on a session that
 * already carries a repair-run boundary — the session stays repair-armed
 * (a repair lifecycle keeps recording), so ANY full re-run re-appends the
 * already-recorded prefix (`session-action-recorder.ts` pushes
 * unconditionally), duplicating it in the healed slice. This fires REGARDLESS
 * of whether `--save-script` is passed this invocation (omitting the flag
 * does not disarm the session). A `--from` resume (`entryIndex > 0`)
 * legitimately continues the same armed run and is allowed.
 */
function preflightReplayAgainstActiveRepair(params: {
  entryIndex: number;
  coordinator: ReplayCoordinator;
}): DaemonResponse | undefined {
  const { entryIndex, coordinator } = params;
  if (entryIndex > 0) return undefined;
  if (coordinator.view()?.repairBoundary === undefined) return undefined;
  return errorResponse(
    'INVALID_ARGS',
    'This session has an active --save-script repair run; continue it with replay --from <n> --plan-digest <sha256>, or finish with close, before starting a fresh full replay.',
  );
}

/**
 * #1258: arm-time EEXIST preflight. Absent this, a repair-armed run's target
 * is only checked at PUBLISH time (`publishHealedScriptAtomically`, on
 * `close`/completion) — by then the ENTIRE repair (agent's corrective steps
 * included) may already have executed against the device, only to fail on a
 * pre-existing target at the very end. Resolves the SAME target
 * the coordinator's `armStep` would (explicit `--save-script=<path>` always
 * wins; otherwise an already-armed session's existing path if this is a
 * `--from` continuation leg reusing it, else the default `<stem>.healed.ad`
 * sibling) WITHOUT needing the session to exist yet, so it runs before step 1
 * dispatches even when that step is the `open` that creates the session.
 * READ-ONLY: it never mutates the session (it runs before
 * `resolveScriptTarget`).
 *
 * The effective-force decision MATCHES `resolveScriptTarget`'s per-target
 * contract, computed against the target THIS request resolves to: a live
 * `--force`/`--overwrite` always bypasses; a PERSISTED per-target grant
 * bypasses ONLY when this request writes to the SAME target it was granted for
 * (`targetPath === existingSaveScriptPath`). An explicit RETARGET to a
 * different path without a live force does NOT bypass here — because
 * `resolveScriptTarget` will CLEAR that persisted force for the new target
 * before publication anyway, so letting the run execute (mutating the session
 * mid-flight) only to refuse the existing target at the end is exactly what
 * this preflight exists to prevent. A no-op when `--save-script` was not passed.
 */
function preflightSaveScriptTarget(params: {
  saveScript: boolean | string | undefined;
  liveForce: boolean | undefined;
  persistedForce: boolean | undefined;
  sourcePath: string;
  existingSaveScriptPath: string | undefined;
}): DaemonResponse | undefined {
  const { saveScript, liveForce, persistedForce, sourcePath, existingSaveScriptPath } = params;
  if (!saveScript) return undefined;
  const targetPath =
    typeof saveScript === 'string'
      ? expandSessionPath(saveScript)
      : (existingSaveScriptPath ?? healedScriptSiblingPath(sourcePath));
  const effectiveForce =
    Boolean(liveForce) || (Boolean(persistedForce) && targetPath === existingSaveScriptPath);
  if (effectiveForce) return undefined;
  if (!fs.existsSync(targetPath)) return undefined;
  return errorResponse(
    'COMMAND_FAILED',
    `A file already exists at ${targetPath}; remove it, pass replay --save-script=<other-path>, or pass --force/--overwrite to replace it.`,
  );
}

/**
 * ADR 0012 decision 6 (Fix 3): the source plan's own terminal `close` is
 * lifecycle, not a script step to replay, while a repair is armed — the agent
 * finalizes the transaction with `close --save-script` instead
 * (`session-close.ts`). Replaying the recorded `close` here would dispatch it
 * as an ordinary step: it tears the session down (and, absent Fix 1/2, could
 * even publish or diverge) before the agent gets that chance. The pure
 * decision (`resolveSuppressedTerminalCloseIndex`, unified with #1554's
 * `--keep-session` suppression) now lives in `@agent-device/ad-replay`'s step
 * loop; this daemon-only preflight — the arm-time EEXIST check above — is
 * unrelated repair authority that stays here.
 */
function createReplaySaveScriptArmer(params: {
  saveScript: boolean | string | undefined;
  force: boolean | undefined;
  coordinator: ReplayCoordinator;
  sourcePath: string;
}): () => void {
  const { saveScript, force, coordinator, sourcePath } = params;
  if (!saveScript) return () => {};
  let firstArm = true;
  return () => {
    coordinator.armStep({ saveScript, force, sourcePath, firstArm });
    firstArm = false;
  };
}
