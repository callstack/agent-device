import { assertMaestroReplayStartIndex, resolveMaestroReplayStartIndex } from './replay-plan.ts';
import { executeMaestroReplayPlan } from './replay-plan-execution.ts';
import type {
  MaestroEngineOptions,
  MaestroEngineResult,
  MaestroRuntimePort,
} from './engine-types.ts';
import type { MaestroReplayPlan } from './replay-plan-types.ts';

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
  options: MaestroEngineOptions,
): number {
  return options.from !== undefined || options.planDigest !== undefined
    ? resolveMaestroReplayStartIndex(plan, {
        from: options.from,
        planDigest: options.planDigest,
      })
    : assertMaestroReplayStartIndex(plan, options.startIndex ?? 0);
}
