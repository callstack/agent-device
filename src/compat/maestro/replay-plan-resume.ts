import { AppError } from '../../kernel/errors.ts';
import type {
  MaestroReplayPlan,
  MaestroReplayResumePreflight,
  MaestroReplayResumeRequest,
} from './replay-plan-types.ts';

export function evaluateMaestroReplayResume(
  plan: MaestroReplayPlan,
  request: MaestroReplayResumeRequest = {},
): MaestroReplayResumePreflight {
  const { from, planDigest } = request;
  if (from === undefined && planDigest === undefined) return { allowed: true, startIndex: 0 };
  if (from === undefined || planDigest === undefined) {
    return {
      allowed: false,
      reason: 'replay --from requires --plan-digest (and --plan-digest requires --from).',
    };
  }
  if (!Number.isInteger(from) || from < 1 || from > plan.total) {
    return {
      allowed: false,
      reason: `replay --from ${from} is out of range for a ${plan.total}-step plan.`,
    };
  }
  if (planDigest !== plan.digest) {
    return {
      allowed: false,
      reason: 'replay --plan-digest does not match the current plan digest.',
    };
  }
  if (from === 1) return { allowed: true, startIndex: 0 };
  for (let index = 0; index < from - 1; index += 1) {
    const step = plan.steps[index]!;
    if (step.kind === 'opaque') {
      return {
        allowed: false,
        reason: `step ${index + 1} is opaque runtime control flow (${step.command.kind}) and cannot be skipped safely.`,
      };
    }
    if (step.command.kind === 'runScript') {
      return {
        allowed: false,
        reason: `step ${index + 1} (runScript) can produce outputEnv values and cannot be skipped safely.`,
      };
    }
  }
  const target = plan.steps[from - 1]!;
  if (target.kind === 'opaque') {
    return {
      allowed: false,
      reason: `step ${from} is opaque runtime control flow (${target.command.kind}) and cannot be resumed into.`,
    };
  }
  return { allowed: true, startIndex: from - 1 };
}

export function resolveMaestroReplayStartIndex(
  plan: MaestroReplayPlan,
  request: MaestroReplayResumeRequest = {},
): number {
  const result = evaluateMaestroReplayResume(plan, request);
  if (!result.allowed) throw new AppError('INVALID_ARGS', result.reason);
  return result.startIndex;
}

export function assertMaestroReplayStartIndex(plan: MaestroReplayPlan, startIndex: number): number {
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > plan.total) {
    throw new AppError(
      'INVALID_ARGS',
      `Maestro replay startIndex ${startIndex} is out of range for a ${plan.total}-step plan.`,
    );
  }
  return startIndex;
}
