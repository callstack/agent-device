import type { SessionAction } from '@agent-device/contracts/session';
import type { ReplayDivergenceResume, ReplayRepairHint } from '@agent-device/contracts/divergence';
import type { ReplayResumeStamper } from '../session-replay-coordinator.ts';

/**
 * Builds the `resume` object and, through the caller's `ReplayResumeStamper` — the narrow
 * capability bound to the request's single `ReplayCoordinator` instance (#1478 P4b) — stamps
 * #1262's corrective-resume watermark on the session. This module never constructs a
 * coordinator or touches a `SessionStore` itself: it can only act through the capability it was
 * handed. Both divergence sites (`session-replay-target-verification.ts`,
 * `session-replay-divergence.ts`) call this as their one `resume`-building entry point.
 */
export function buildAndPersistReplayDivergenceResume(params: {
  readonly failedIndex: number;
  readonly actions: SessionAction[];
  readonly planDigest: string;
  readonly repairHint: ReplayRepairHint;
  readonly resumeStamper: ReplayResumeStamper;
}): ReplayDivergenceResume {
  const resume = buildReplayDivergenceResume({
    failedIndex: params.failedIndex,
    actions: params.actions,
    planDigest: params.planDigest,
    repairHint: params.repairHint,
    sessionExists: params.resumeStamper.sessionExists(),
  });
  params.resumeStamper.stampCorrectiveWatermark({
    resume,
    repairHint: params.repairHint,
    failedIndex: params.failedIndex,
    actions: params.actions,
  });
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
 * `formatReplayDivergenceReport` (`packages/contracts/src/replay-divergence.ts`) — both are
 * derived from the same computed `from` value.
 *
 * `failedIndex` is always a valid 1-based index into `actions` (both call
 * sites resolve it from the plan they are actively executing), so the shifted
 * `from` is at most `actions.length + 1` — never further out of range. That
 * boundary case (`record-and-heal` diverged on the plan's LAST step) is a
 * legal EMPTY-TAIL resume, not an error: the runtime loop
 * (`runReplayScriptSource`) executes zero steps and reaches the normal
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
 *    and that watermark can only be stamped on a LIVE session (the
 *    `ReplayResumeStamper`'s `stampCorrectiveWatermark`, called from both
 *    divergence sites via `buildAndPersistReplayDivergenceResume` above, is a
 *    no-op without one). With no session — a one-step `open` failure, or a
 *    session closed mid-replay —
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
