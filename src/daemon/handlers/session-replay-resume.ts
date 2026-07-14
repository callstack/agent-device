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
 */
export function buildReplayDivergenceResume(params: {
  failedIndex: number; // 1-based
  actions: SessionAction[];
  planDigest: string;
  repairHint: ReplayRepairHint;
}): ReplayDivergenceResume {
  const { failedIndex, actions, planDigest, repairHint } = params;
  const from = repairHint === 'record-and-heal' ? failedIndex + 1 : failedIndex;
  const preflight = evaluateReplayResumePreflight({ from, actions });
  return preflight.allowed
    ? { allowed: true, from, planDigest }
    : { allowed: false, from, planDigest, reason: preflight.reason };
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
