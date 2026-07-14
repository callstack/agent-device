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
  const normalizedOptions = normalizeMaestroEngineOptions(options);
  const plan = await compileMaestroReplayPlan(program, normalizedOptions);
  const startIndex = resolveExecutionStartIndex(plan, normalizedOptions);
  return await executeMaestroReplayPlan(plan, port, { ...normalizedOptions, startIndex });
}

export async function executeMaestroPlan(
  plan: MaestroReplayPlan,
  port: MaestroRuntimePort,
  options: MaestroEngineOptions = {},
): Promise<MaestroEngineResult> {
  const normalizedOptions = normalizeMaestroEngineOptions(options);
  const startIndex = resolveExecutionStartIndex(plan, normalizedOptions);
  return await executeMaestroReplayPlan(plan, port, { ...normalizedOptions, startIndex });
}

function normalizeMaestroEngineOptions(
  options: MaestroEngineOptions,
): MaestroEngineExecutionOptions {
  const { builtins, ...normalizedOptions } = options;
  if (builtins === undefined) return normalizedOptions;
  return {
    ...normalizedOptions,
    defaults: { ...(normalizedOptions.defaults ?? {}), ...builtins },
  };
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
