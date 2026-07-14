import type { MaestroProgram } from './program-ir.ts';
import {
  assertMaestroReplayStartIndex,
  compileMaestroReplayPlan,
  resolveMaestroReplayStartIndex,
} from './replay-plan.ts';
import { executeMaestroReplayPlan } from './replay-plan-execution.ts';
import type {
  MaestroEngineExecutionOptions,
  MaestroEngineOptions,
  MaestroEngineResult,
  MaestroRuntimePort,
} from './engine-types.ts';
import type { MaestroReplayPlan } from './replay-plan-types.ts';

export async function executeMaestroProgram(
  program: MaestroProgram,
  port: MaestroRuntimePort,
  options: MaestroEngineOptions = {},
): Promise<MaestroEngineResult> {
  const plan = await compileMaestroReplayPlan(program, options);
  const startIndex = resolveExecutionStartIndex(plan, options);
  return await executeMaestroReplayPlan(plan, port, { ...options, startIndex });
}

export async function executeMaestroPlan(
  plan: MaestroReplayPlan,
  port: MaestroRuntimePort,
  options: MaestroEngineOptions = {},
): Promise<MaestroEngineResult> {
  const startIndex = resolveExecutionStartIndex(plan, options);
  return await executeMaestroReplayPlan(plan, port, { ...options, startIndex });
}

function resolveExecutionStartIndex(
  plan: MaestroReplayPlan,
  options: MaestroEngineExecutionOptions,
): number {
  return options.from !== undefined || options.planDigest !== undefined
    ? resolveMaestroReplayStartIndex(plan, {
        from: options.from,
        planDigest: options.planDigest,
      })
    : assertMaestroReplayStartIndex(plan, options.startIndex ?? 0);
}
