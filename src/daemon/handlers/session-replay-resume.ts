import { MAESTRO_RUNTIME_COMMAND } from '../../compat/maestro/runtime-commands.ts';
import type { SessionAction } from '../types.ts';
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
 */
export function buildReplayDivergenceResume(params: {
  failedIndex: number; // 1-based
  actions: SessionAction[];
  planDigest: string;
  repairHint: ReplayRepairHint;
}): ReplayDivergenceResume {
  const { failedIndex, actions, planDigest, repairHint } = params;
  const from = repairHint === 'record-and-heal' ? failedIndex + 1 : failedIndex;
  if (from > actions.length) {
    return {
      allowed: false,
      from,
      planDigest,
      reason:
        `replay --from ${from} would be out of range for this ${actions.length}-step plan; ` +
        'the corrective action already completes the script, so finish the repair with close instead of --from.',
    };
  }
  const preflight = evaluateReplayResumePreflight({ from, actions });
  return preflight.allowed
    ? { allowed: true, from, planDigest }
    : { allowed: false, from, planDigest, reason: preflight.reason };
}
