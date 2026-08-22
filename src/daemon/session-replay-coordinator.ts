import type { SessionAction } from '@agent-device/contracts/session';
import path from 'node:path';
import {
  readReplayDivergenceResume,
  type ReplayDivergenceResume,
  type ReplayRepairHint,
} from '@agent-device/contracts/divergence';
import type { DaemonResponse, SessionState } from './types.ts';
import type { SessionStore } from './session-store.ts';
import {
  armRepairStep,
  isUncommittedRepairSession,
  markRepairTransactionComplete,
  repairSessionBoundary,
  resetRepairCompletionForRerun,
} from './session-replay-transaction.ts';

/**
 * `ReplayCoordinator` (#1478 P4b): the single daemon-owned gateway a native `.ad` replay request
 * uses to reach the P4a `ReplaySessionTransaction` projection (`session-replay-transaction.ts`)
 * and the corrective-resume watermark. One instance is scoped to one locked replay request
 * (`sessionStore` + `sessionName`, ADR 0012 decision 6's "the repair transaction spans the whole
 * live session"); it owns every write this request performs against that session's repair
 * lifecycle — arming, demotion for a `--from` rerun, completion, hold-on-divergence stamping, the
 * `pendingRecordAndHeal` corrective watermark, and reap-tombstone clearing —
 * so `session-replay-runtime.ts` and `session-replay-resume.ts` reach neither the P4a projection
 * nor `session.pendingRecordAndHeal` directly.
 *
 * Close-time sequencing (`session-close.ts`, `session-close-script.ts`: the platform-close
 * receipt, the repair-armed check gating targeted platform close, and the terminal abort) is a
 * different capability with its own teardown ordering — commit/abort happen at teardown, not
 * during a replay request — and remains a direct `ReplaySessionTransaction` caller by design; see
 * the P4b PR description for the ownership split.
 */

/** Immutable read projection of the repair-transaction fields this coordinator's writers touch. */
export type ReplaySessionView = Readonly<{
  /** The R6 boundary watermark, or `undefined` when the session carries no repair transaction. */
  repairBoundary: number | undefined;
  /** #1262's corrective-resume watermark, or `undefined` when none is pending. */
  pendingRecordAndHeal:
    | Readonly<{ expectedFrom: number; actionsCountAtDivergence: number }>
    | undefined;
}>;

/**
 * The one capability the divergence-report chain (`session-replay-resume.ts`,
 * `session-replay-divergence.ts`, `session-replay-target-verification.ts`) needs from a
 * `ReplayCoordinator`, bound to the SAME instance the owning `runReplayScriptSource` call
 * created — never a second construction from a bare session name. Carries no `SessionStore`
 * and cannot name or reacquire a different session.
 */
export type ReplayResumeStamper = Readonly<{
  /** Whether the request's session currently exists (gates the empty-tail `alternateFrom`). */
  sessionExists(): boolean;
  /** Stamps the corrective-resume watermark for a divergence; a no-op before step 1 creates the session. */
  stampCorrectiveWatermark(params: {
    resume: ReplayDivergenceResume;
    repairHint: ReplayRepairHint;
    failedIndex: number;
    actions: SessionAction[];
  }): void;
}>;

export type ReplayCoordinator = {
  /** Reads the request's current session state, or `undefined` before step 1 creates it. */
  view(): ReplaySessionView | undefined;

  /** ADR 0012 R1/R6: arms (or re-arms, per step) the repair transaction. A no-op before step 1 creates the session. */
  armStep(params: {
    saveScript: boolean | string;
    force: boolean | undefined;
    sourcePath: string;
    firstArm: boolean;
  }): void;

  /** ADR 0012 R2: demotes a completed transaction back to `armed` for a `--from` rerun; a no-op outside repair. */
  demoteForRerunIfArmed(): void;

  /** ADR 0012 C2: flips an armed repair transaction to `complete`; a no-op outside repair. */
  markCompleteIfArmed(): void;

  /** ADR 0012 R7 (C1): stamps `resume.repairSessionHeld` on a divergence whose transaction is uncommitted. */
  markSessionHeldIfArmed(response: DaemonResponse): DaemonResponse;

  /** ADR 0012 R7 (C5a): clears this session key's reap tombstone. */
  clearTombstone(): void;

  /** Retires the watermark once a `--from` matching `expectedFrom` has actually been entered. */
  clearCorrectiveWatermarkIfExpected(expectedFrom: number | undefined): void;

  /** The narrow capability threaded into the divergence-report chain. */
  readonly resumeStamper: ReplayResumeStamper;
};

export function createReplayCoordinator(params: {
  sessionStore: SessionStore;
  sessionName: string;
}): ReplayCoordinator {
  const { sessionStore, sessionName } = params;
  const current = (): SessionState | undefined => sessionStore.get(sessionName);

  const resumeStamper: ReplayResumeStamper = {
    sessionExists: () => current() !== undefined,
    stampCorrectiveWatermark(watermarkParams): void {
      const session = current();
      if (!session) return;
      stampPendingRecordAndHealWatermark({ session, ...watermarkParams });
      sessionStore.set(sessionName, session);
    },
  };

  return {
    view(): ReplaySessionView | undefined {
      const session = current();
      if (!session) return undefined;
      return {
        repairBoundary: repairSessionBoundary(session),
        pendingRecordAndHeal: session.pendingRecordAndHeal,
      };
    },

    armStep(stepParams): void {
      const session = current();
      if (!session) return;
      armRepairStep(session, {
        saveScript: stepParams.saveScript,
        force: stepParams.force,
        sourcePath: stepParams.sourcePath,
        healedSiblingPath: healedScriptSiblingPath(stepParams.sourcePath),
        firstArm: stepParams.firstArm,
      });
      sessionStore.set(sessionName, session);
    },

    demoteForRerunIfArmed(): void {
      const session = current();
      if (!session || repairSessionBoundary(session) === undefined) return;
      resetRepairCompletionForRerun(session);
    },

    markCompleteIfArmed(): void {
      const session = current();
      if (!session || repairSessionBoundary(session) === undefined) return;
      markRepairTransactionComplete(session);
      sessionStore.set(sessionName, session);
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
      sessionStore.clearRepairTombstone(sessionName);
    },

    clearCorrectiveWatermarkIfExpected(expectedFrom): void {
      const session = current();
      if (!session || session.pendingRecordAndHeal?.expectedFrom !== expectedFrom) return;
      clearPendingRecordAndHealWatermark(session);
      sessionStore.set(sessionName, session);
    },

    resumeStamper,
  };
}

/** `flows/login.ad` -> `flows/login.healed.ad`, beside the original (R6). */
export function healedScriptSiblingPath(sourcePath: string): string {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(dir, `${base}.healed.ad`);
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
