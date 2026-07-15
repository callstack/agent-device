import type { SessionAction, SessionState } from '../types.ts';
import type { ReplayDivergenceResume, ReplayRepairHint } from '../../replay/divergence.ts';
import { SessionStore } from '../session-store.ts';

export function buildAndPersistReplayDivergenceResume(params: {
  readonly failedIndex: number;
  readonly actions: SessionAction[];
  readonly planDigest: string;
  readonly repairHint: ReplayRepairHint;
  readonly sessionStore: SessionStore;
  readonly sessionName: string;
}): ReplayDivergenceResume {
  const session = params.sessionStore.get(params.sessionName);
  const resume = buildReplayDivergenceResume({
    failedIndex: params.failedIndex,
    actions: params.actions,
    planDigest: params.planDigest,
    repairHint: params.repairHint,
    sessionExists: session !== undefined,
  });
  if (session) {
    stampPendingRecordAndHealWatermark({
      session,
      resume,
      repairHint: params.repairHint,
      failedIndex: params.failedIndex,
      actions: params.actions,
    });
    params.sessionStore.set(params.sessionName, session);
  }
  return resume;
}

/**
 * Builds the `resume` object attached to every divergence report. `from` is
 * the ordinal the agent should actually pass to `--from`, not merely the
 * failed step's index: per ADR 0012 decision 6, R2, a `record-and-heal`
 * repair has the agent perform the diverged step manually before this report
 * is acted on, so the correct continuation is `failedIndex + 1` (re-running
 * `failedIndex` would re-diverge on the step the agent already performed).
 * Every other repair hint (including a plain `action-failure`) resumes AT
 * `failedIndex` unchanged. This must agree with the text guidance rendered by
 * `formatReplayDivergenceReport` (`src/replay/divergence.ts`) — both are
 * derived from the same computed `from` value.
 *
 * `failedIndex` is always a valid 1-based index into `actions` (both call
 * sites resolve it from the plan they are actively executing), so the shifted
 * `from` is at most `actions.length + 1` — never further out of range. That
 * boundary case (`record-and-heal` diverged on the plan's LAST step) is a
 * legal EMPTY-TAIL resume, not an error: the runtime loop
 * (`runReplayScriptFile`) executes zero steps and reaches the normal
 * end-of-plan completion path, correctly flipping a repair transaction
 * COMPLETE. Rejecting it would send the agent to `close` instead —
 * which discards the just-recorded corrective action, since commit is gated
 * on that same COMPLETE flag.
 *
 * `alternateFrom` (#1262) is the `caution`/`manual` dual-path's SECOND
 * ordinal (`failedIndex + 1`, the record-and-heal-shaped alternate) — see
 * `computeReplayResumeAlternateFrom`.
 */
export function buildReplayDivergenceResume(params: {
  failedIndex: number; // 1-based
  actions: SessionAction[];
  planDigest: string;
  repairHint: ReplayRepairHint;
  // Whether a live session exists at divergence time — the `pendingRecordAndHeal`
  // watermark can only be stamped on a session, so it gates the empty-tail
  // (one-past-the-end) `alternateFrom`. See `computeReplayResumeAlternateFrom`.
  sessionExists: boolean;
}): ReplayDivergenceResume {
  const { failedIndex, actions, planDigest, repairHint, sessionExists } = params;
  const from = repairHint === 'record-and-heal' ? failedIndex + 1 : failedIndex;
  const alternateFrom = computeReplayResumeAlternateFrom({
    failedIndex,
    actions,
    repairHint,
    sessionExists,
  });
  return {
    allowed: true,
    from,
    planDigest,
    ...(alternateFrom !== undefined ? { alternateFrom } : {}),
  };
}

/**
 * ADR 0012 decision 4 / #1262: the `caution`/`manual` dual-path's SECOND
 * ordinal, the record-and-heal-shaped alternate (`failedIndex + 1`). Generic
 * `.ad` plans contain neither runtime variable producers nor control wrappers,
 * so every in-range ordinal is resumable.
 *
 * The alternate has two acceptance regimes by position:
 *  - MID-PLAN (`failedIndex + 1 <= actions.length`): in range, needs no
 *    watermark and is session-independent.
 *  - LAST STEP / EMPTY-TAIL (`failedIndex + 1 > actions.length`, one past the
 *    plan's end): the range check accepts this ordinal ONLY when it matches a
 *    stamped `pendingRecordAndHeal` watermark (`describeOutOfRangeResumeFrom`),
 *    and that watermark can only be stamped on a LIVE session (both divergence
 *    sites gate `stampPendingRecordAndHealWatermark` on `if (session)`). With
 *    no session — a one-step `open` failure, or a session closed mid-replay —
 *    the watermark can never be stamped, so `--from actions.length + 1` would
 *    be rejected as out of range; advertising it would re-introduce the exact
 *    text/structured mismatch #1262 fixed. So the empty-tail alternate
 *    additionally requires `sessionExists`.
 *
 * Absent for `record-and-heal` (its `from` already IS `failedIndex + 1`) and
 * `state-repair` (no recorded-action alternate). The text renderer gates the
 * `N + 1` command on this field's presence rather than re-deriving
 * resumability, keeping text and the structured wire in agreement.
 */
function computeReplayResumeAlternateFrom(params: {
  failedIndex: number;
  actions: SessionAction[];
  repairHint: ReplayRepairHint;
  sessionExists: boolean;
}): number | undefined {
  const { failedIndex, actions, repairHint, sessionExists } = params;
  if (repairHint !== 'caution' && repairHint !== 'manual') return undefined;
  const alternateFrom = failedIndex + 1;
  // Empty-tail: authorizable only via a watermark, which needs a live session.
  if (alternateFrom > actions.length && !sessionExists) return undefined;
  return alternateFrom;
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
 * the SAME watermark
 * `record-and-heal` uses, which — as an unavoidable side effect of sharing
 * the mechanism — also puts `describeUnperformedRecordAndHeal`'s
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
