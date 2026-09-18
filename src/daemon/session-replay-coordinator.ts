import type { SessionAction } from '@agent-device/contracts/session';
import type { ReplayDivergenceResume, ReplayRepairHint } from '@agent-device/contracts/divergence';
import { readReplayDivergenceResume } from '@agent-device/ad-replay/divergence';
import type { DaemonResponse } from './daemon-request.ts';
import type { SessionRuntimeHints, SessionState } from './session-state.ts';
import {
  armRepairStep,
  isUncommittedRepairSession,
  markRepairTransactionComplete,
  repairSessionBoundary,
  resetRepairCompletionForRerun,
} from './session-replay-transaction.ts';
import {
  NO_SCRIPT_PUBLICATION,
  scriptTargetForce,
  scriptTargetPath,
  type SessionScriptPublicationState,
} from './session-script-publication-state.ts';
import {
  healedScriptSiblingPath,
  type ReplayCoordinator,
  type ReplayResumeStamper,
  type ReplaySessionView,
} from './replay/index.ts';

/**
 * `ReplayCoordinator` (#1478 P4b): the single daemon-owned gateway a native `.ad` replay request
 * uses to reach the P4a `ReplaySessionTransaction` projection (`session-replay-transaction.ts`)
 * and the corrective-resume watermark. One instance is scoped to one locked replay request
 * (the request-bound read and mutation capabilities, ADR 0012 decision 6's "the repair
 * transaction spans the whole live session"); it owns every write this request performs against
 * that session's repair lifecycle — arming, demotion for a `--from` rerun, completion,
 * hold-on-divergence stamping, the `pendingRecordAndHeal` corrective watermark, and reap-tombstone clearing —
 * so the replay command and its resume helper reach neither the P4a projection
 * nor `session.pendingRecordAndHeal` directly.
 *
 * Close-time sequencing (`session-lifecycle/internal/session-close.ts`,
 * `session-lifecycle/internal/session-close-script.ts`: the platform-close receipt, the
 * repair-armed check gating targeted platform close, and the terminal abort) is a different
 * capability with its own teardown ordering — commit/abort happen at teardown, not during a
 * replay request — and remains a direct `ReplaySessionTransaction` caller by design; see the
 * P4b PR description for the ownership split.
 */

export type ReplaySessionStore = Readonly<{
  get: () => Readonly<SessionState> | undefined;
  lookup: () =>
    | Readonly<{
        address: string;
        session: Readonly<SessionState>;
      }>
    | undefined;
  getRuntimeHints: () => SessionRuntimeHints | undefined;
  ensureSessionDir: () => string;
}>;

export type ReplaySessionMutationStore = Readonly<{
  update: (mutate: (session: SessionState) => void) => boolean;
  clearRepairTombstone: () => void;
}>;

export function createReplayCoordinator(params: {
  sessionStore: ReplaySessionStore;
  mutationStore: ReplaySessionMutationStore;
}): ReplayCoordinator {
  const { sessionStore, mutationStore } = params;
  const current = (): Readonly<SessionState> | undefined => sessionStore.get();

  const resumeStamper: ReplayResumeStamper = {
    sessionExists: () => current() !== undefined,
    stampCorrectiveWatermark(watermarkParams): void {
      mutationStore.update((session) => {
        stampPendingRecordAndHealWatermark({ session, ...watermarkParams });
      });
    },
  };

  return {
    view(): ReplaySessionView | undefined {
      const session = current();
      if (!session) return undefined;
      return {
        repairBoundary: repairSessionBoundary(session),
        pendingRecordAndHeal: session.pendingRecordAndHeal,
        scriptPublication: projectScriptPublication(
          session.scriptPublication ?? NO_SCRIPT_PUBLICATION,
        ),
      };
    },

    armStep(stepParams): void {
      mutationStore.update((session) => {
        armRepairStep(session, {
          saveScript: stepParams.saveScript,
          force: stepParams.force,
          sourcePath: stepParams.sourcePath,
          healedSiblingPath: healedScriptSiblingPath(stepParams.sourcePath),
          firstArm: stepParams.firstArm,
        });
      });
    },

    demoteForRerunIfArmed(): void {
      if (repairSessionBoundary(current()) === undefined) return;
      mutationStore.update(resetRepairCompletionForRerun);
    },

    markCompleteIfArmed(): void {
      if (repairSessionBoundary(current()) === undefined) return;
      mutationStore.update(markRepairTransactionComplete);
    },

    markSessionHeldIfArmed(response): DaemonResponse {
      if (response.ok) return response;
      // The transaction is active iff the session is repair-armed and not yet
      // committed — the PERSISTED state, NOT this request's `--save-script` flag.
      // A `replay --from` continuation (which does not repeat `--save-script`,
      // per R2) is therefore still held on divergence and stays in the
      // transaction.
      if (!isUncommittedRepairSession(current())) return response;
      const resume = readReplayDivergenceResume(response.error.details?.divergence);
      if (resume) resume.repairSessionHeld = true;
      return response;
    },

    clearTombstone(): void {
      mutationStore.clearRepairTombstone();
    },

    clearCorrectiveWatermarkIfExpected(expectedFrom): void {
      if (current()?.pendingRecordAndHeal?.expectedFrom !== expectedFrom) return;
      mutationStore.update((session) => {
        if (session.pendingRecordAndHeal?.expectedFrom === expectedFrom) {
          clearPendingRecordAndHealWatermark(session);
        }
      });
    },

    resumeStamper,
  };
}

/** The publication state as replay's arming preflight reads it: kind, status, target, force. */
function projectScriptPublication(
  state: SessionScriptPublicationState,
): ReplaySessionView['scriptPublication'] {
  return {
    kind: state.kind,
    status: state.kind === 'none' ? undefined : state.status,
    targetPath: scriptTargetPath(state),
    targetForce: scriptTargetForce(state),
  };
}

/**
 * ADR 0012 decision 6, R2/R3, extended per #1262: a `record-and-heal`
 * divergence's `resume.from` assumes the agent performs the diverged step
 * manually before continuing — nothing else enforces that, mid-plan or at
 * the plan's LAST step, so the watermark is stamped unconditionally
 * (position-independent) whenever `resume.allowed`.
 *
 * `caution` (identity-mismatch) and `manual` are different in kind:
 * `resume.from` stays at the failed step's own index `N` unconditionally (a
 * `--no-record` app-state fix re-runs the unchanged step, and #1262 requires
 * `N` never be made illegal for these hints), and — UNLIKE `record-and-heal`
 * — a mid-plan `--from N + 1` was ALREADY unconditionally legal (in range,
 * `<= actionCount`) and un-gated before #1262: these hints never mandate a
 * corrective action the way `record-and-heal` does, so an agent may
 * legitimately decide to skip the diverged step's execution entirely
 * (dropping it from a healed script) and continue. That pre-existing,
 * un-gated pattern must not regress.
 *
 * The ONE gap #1262 closes is the boundary case: when the diverged step IS
 * the plan's LAST step, `N + 1` is one past the plan's end — previously
 * ALWAYS out of range for `caution`/`manual` (dead end: `close` on the
 * not-yet-COMPLETE transaction discards a just-recorded corrective action).
 * Only THAT boundary ordinal is newly authorized here. Authorizing it stamps
 * the SAME watermark `record-and-heal` uses, which — as an unavoidable side
 * effect of sharing the mechanism — also puts `describeUnperformedRecordAndHeal`'s
 * recorded-corrective-action guard in front of that specific `N + 1`
 * request: the empty-tail exception is new, so proof it was earned is
 * required, same as record-and-heal's requirement.
 *
 * Called at every divergence site (not only the eligible hints/positions) so
 * a stale watermark from an earlier divergence never survives an unrelated
 * later one: an ineligible hint or a mid-plan `caution`/`manual` divergence
 * clears the field.
 */
export function stampPendingRecordAndHealWatermark(params: {
  session: SessionState;
  resume: ReplayDivergenceResume;
  repairHint: ReplayRepairHint;
  failedIndex: number; // 1-based, the diverged step's own plan ordinal (N)
  actions: SessionAction[];
}): void {
  const { session, resume, repairHint, failedIndex, actions } = params;
  session.pendingRecordAndHeal = computeRecordAndHealWatermark({
    resume,
    repairHint,
    failedIndex,
    actions,
    actionsCountAtDivergence: session.actions.length,
  });
}

/**
 * Retire the watermark once the resume it was stamped for has actually been entered. The clear
 * belongs beside the stamp: both are statements about when the field is meaningful, and the
 * caller that enters the resume knows only that it matched, not what the field means.
 */
function clearPendingRecordAndHealWatermark(session: SessionState): void {
  session.pendingRecordAndHeal = undefined;
}

function computeRecordAndHealWatermark(params: {
  resume: ReplayDivergenceResume;
  repairHint: ReplayRepairHint;
  failedIndex: number;
  actions: SessionAction[];
  actionsCountAtDivergence: number;
}): { expectedFrom: number; actionsCountAtDivergence: number } | undefined {
  const { resume, repairHint, failedIndex, actions, actionsCountAtDivergence } = params;
  if (repairHint === 'record-and-heal') {
    return resume.allowed ? { expectedFrom: resume.from, actionsCountAtDivergence } : undefined;
  }
  if (repairHint !== 'caution' && repairHint !== 'manual') return undefined;
  // #1262: only the LAST-step empty-tail alternate is newly authorized —
  // see the function doc comment for why mid-plan `N + 1` stays un-gated.
  if (failedIndex !== actions.length) return undefined;
  const expectedFrom = failedIndex + 1;
  return { expectedFrom, actionsCountAtDivergence };
}
