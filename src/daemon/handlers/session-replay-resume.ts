import { MAESTRO_RUNTIME_COMMAND } from '../../compat/maestro/runtime-commands.ts';
import type { SessionAction, SessionState } from '../types.ts';
import type { ReplayDivergenceResume, ReplayRepairHint } from '../../replay/divergence.ts';

/**
 * ADR 0012 decision 4 / migration step 5: resume does not reconstruct
 * execution state. For a target `from` (1-based, into the SAME top-level
 * `actions` array the replay runtime iterates) greater than 1, preflight
 * rejects when any SKIPPED step (`1..from-1`) can produce `outputEnv`
 * values a later step might consume, or when the skipped range or the
 * resume target itself is a runtime control-flow wrapper (`retry` or
 * `maestroRunFlowWhen` — evaluated dynamically, never expanded into
 * individually addressable plan indices, so skipping into/over one cannot be
 * proven safe). `from === 1` skips nothing and is always allowed.
 */
export type ReplayResumePreflightResult = { allowed: true } | { allowed: false; reason: string };

// The only outputEnv producer today (`invokeMaestroRunScript`,
// `compat/maestro/runtime.ts`); a plain command's response is never merged
// into replay var scope (`readReplayOutputEnv`,
// `session-replay-action-runtime.ts`).
const OUTPUT_ENV_PRODUCING_COMMAND: string = MAESTRO_RUNTIME_COMMAND.runScript;

export function evaluateReplayResumePreflight(params: {
  from: number;
  actions: SessionAction[];
}): ReplayResumePreflightResult {
  const { from, actions } = params;
  if (from <= 1) return { allowed: true };

  for (let index = 0; index <= from - 2; index += 1) {
    const action = actions[index];
    if (!action) continue;
    if (action.replayControl) {
      return {
        allowed: false,
        reason: `step ${index + 1} is inside runtime control flow (${action.replayControl.kind}); skipping it without executing it cannot be proven safe.`,
      };
    }
    if (producesOutputEnv(action)) {
      return {
        allowed: false,
        reason: `step ${index + 1} (${action.command}) can produce outputEnv values a later step may consume; skipping it without executing it cannot be proven safe.`,
      };
    }
  }

  const target = actions[from - 1];
  if (target?.replayControl) {
    return {
      allowed: false,
      reason: `step ${from} is inside runtime control flow (${target.replayControl.kind}); it cannot be safely resumed into.`,
    };
  }

  return { allowed: true };
}

function producesOutputEnv(action: SessionAction): boolean {
  return action.command === OUTPUT_ENV_PRODUCING_COMMAND;
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
 * legal EMPTY-TAIL resume, not an error: `evaluateReplayResumePreflight`
 * already proves it safe (it only checks whether the SKIPPED range 1..from-1
 * is safe to skip; there is no `from`-th step to reject), and the runtime
 * loop (`runReplayScriptFile`) executes zero steps and reaches the normal
 * end-of-plan completion path, correctly flipping a repair transaction
 * COMPLETE. Rejecting it here would send the agent to `close` instead —
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
  const preflight = evaluateReplayResumePreflight({ from, actions });
  if (!preflight.allowed) return { allowed: false, from, planDigest, reason: preflight.reason };
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
 * ordinal, the record-and-heal-shaped alternate (`failedIndex + 1`). Returned
 * ONLY when a `--from failedIndex + 1` request for this divergence would
 * actually be accepted by the daemon — i.e. exactly its own resume preflight
 * passes (`evaluateReplayResumePreflight`, which unlike `from`'s own preflight
 * ALSO requires the DIVERGED step to be skip-safe, since reaching
 * `failedIndex + 1` skips the diverged step). Its checked range is a strict
 * superset of `from`'s, so `alternateFrom` present implies `resume.allowed` —
 * never a contradiction.
 *
 * The alternate has two acceptance regimes by position:
 *  - MID-PLAN (`failedIndex + 1 <= actions.length`): in range, needs no
 *    watermark — session-independent, gated on the preflight alone.
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
 * `state-repair` (no recorded-action alternate); absent when the diverged step
 * is a `runScript` (outputEnv producer) or inside runtime control flow, so the
 * alternate `--from failedIndex + 1` would be refused. The text renderer gates
 * the `N + 1` command on this field's PRESENCE rather than re-deriving
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
  if (!evaluateReplayResumePreflight({ from: alternateFrom, actions }).allowed) return undefined;
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
 * Only THAT boundary ordinal is newly authorized here, and only when it is
 * independently preflight-safe (`evaluateReplayResumePreflight` on `N + 1`,
 * NOT the unrelated preflight verdict `resume.allowed` already carries for
 * `N` — a different ordinal). Authorizing it stamps the SAME watermark
 * `record-and-heal` uses, which — as an unavoidable side effect of sharing
 * the mechanism — also puts `describeUnperformedRecordAndHeal`'s
 * recorded-corrective-action guard in front of that specific `N + 1`
 * request: the empty-tail exception is new, so proof it was earned is
 * required, same as record-and-heal's requirement.
 *
 * Called at every divergence site (not only the eligible hints/positions) so
 * a stale watermark from an earlier divergence never survives an unrelated
 * later one: an ineligible hint, a mid-plan `caution`/`manual` divergence, or
 * a last-step `caution`/`manual` divergence whose `N + 1` target is not
 * itself preflight-safe, all clear the field.
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
  const authorized = evaluateReplayResumePreflight({ from: expectedFrom, actions }).allowed;
  return authorized ? { expectedFrom, actionsCountAtDivergence } : undefined;
}
