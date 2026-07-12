import type { MaestroProgram } from './program-ir.ts';
import {
  assertMaestroReplayStartIndex,
  compileMaestroReplayPlan,
  resolveMaestroReplayStartIndex,
} from './replay-plan.ts';
import { executeMaestroReplayPlan } from './replay-plan-execution.ts';
import type {
  MaestroEngineOptions,
  MaestroEngineResult,
  MaestroRuntimePort,
} from './engine-types.ts';

export async function executeMaestroProgram(
  program: MaestroProgram,
  port: MaestroRuntimePort,
  options: MaestroEngineOptions = {},
): Promise<MaestroEngineResult> {
  const plan = await compileMaestroReplayPlan(program, options);
  const startIndex =
    options.from !== undefined || options.planDigest !== undefined
      ? resolveMaestroReplayStartIndex(plan, {
          from: options.from,
          planDigest: options.planDigest,
        })
      : assertMaestroReplayStartIndex(plan, options.startIndex ?? 0);
  return await executeMaestroReplayPlan(plan, port, { ...options, startIndex });
}

export async function executeMaestroPlan(
  plan: import('./replay-plan-types.ts').MaestroReplayPlan,
  port: MaestroRuntimePort,
  options: MaestroEngineOptions = {},
): Promise<MaestroEngineResult> {
  const startIndex =
    options.from !== undefined || options.planDigest !== undefined
      ? resolveMaestroReplayStartIndex(plan, {
          from: options.from,
          planDigest: options.planDigest,
        })
      : assertMaestroReplayStartIndex(plan, options.startIndex ?? 0);
  return await executeMaestroReplayPlan(plan, port, { ...options, startIndex });
}

export { executeMaestroReplayPlan } from './replay-plan-execution.ts';
