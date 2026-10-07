import { AppError } from '@agent-device/kernel/errors';
import { Deadline } from './host.ts';

/**
 * Everything one runner phase may spend: the single clock every step of the phase reads,
 * and the owning request's cancellation. Created once, where the phase begins, and handed
 * on as this object — no step below receives a timeout number it could open a second phase
 * with, which is how a cold probe stall and the build each spent the same budget (#2422).
 */
export type RunnerPhaseBudget = Readonly<{
  /** The phase's clock; absent when its owner carries no budget at all. */
  deadline?: Deadline;
  /** The owning request's cancellation signal, if it carries one. */
  signal?: AbortSignal;
}>;

/**
 * Opens a phase from the numeric timeout its public option carries: the one place a number
 * becomes a budget, so every boundary below it takes the {@link RunnerPhaseBudget} instead.
 */
export function createRunnerPhaseBudget(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): RunnerPhaseBudget {
  const bounded = timeoutMs !== undefined && Number.isFinite(timeoutMs);
  return {
    deadline: bounded ? Deadline.fromTimeoutMs(Math.max(0, timeoutMs)) : undefined,
    signal,
  };
}

/**
 * What the phase has left for its next step, or `undefined` when it carries no deadline.
 * Throws rather than returning zero, so a spent phase fails before it spawns.
 */
export function requireRunnerPhaseRemainingMs(
  budget: RunnerPhaseBudget | undefined,
  phase: string,
): number | undefined {
  const deadline = budget?.deadline;
  if (!deadline) return undefined;
  const remainingMs = Math.floor(deadline.remainingMs());
  if (remainingMs <= 0) throw runnerPhaseBudgetExhaustedError(phase);
  return remainingMs;
}

/** Says the phase budget ran out, not that the step it would have run is broken. */
export function runnerPhaseBudgetExhaustedError(phase: string): AppError {
  return new AppError('COMMAND_FAILED', 'The Apple runner budget ran out before this step began', {
    phase,
    reason: 'runner_phase_budget_exhausted',
    retriable: true,
  });
}

/** The step that threw named its own phase; the caller only needs to know it was the budget. */
export function isRunnerPhaseBudgetExhaustedError(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === 'runner_phase_budget_exhausted';
}
