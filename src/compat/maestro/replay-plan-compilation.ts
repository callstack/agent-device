import { computeMaestroReplayPlanDigest } from './replay-plan-digest.ts';
import type { MaestroProgram } from './program-ir.ts';
import { compileMaestroReplayPlanSteps } from './replay-plan-steps.ts';
import type { MaestroReplayPlan, MaestroReplayPlanOptions } from './replay-plan-types.ts';

export async function compileMaestroReplayPlan(
  program: MaestroProgram,
  options: MaestroReplayPlanOptions = {},
): Promise<MaestroReplayPlan> {
  const { steps, staticallyExecutedControls, staticallySkippedControls } =
    await compileMaestroReplayPlanSteps(program, options);
  const planWithoutDigest = {
    kind: 'maestroReplayPlan' as const,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.target === undefined ? {} : { target: options.target }),
    initialStaticEnv: cloneValue({
      ...(options.defaults ?? {}),
      ...(options.builtins ?? {}),
      ...(program.config.env ?? {}),
      ...(options.env ?? {}),
    }),
    steps: cloneValue(steps),
    total: steps.length,
    compatibility: {
      staticallyExecutedControls,
      staticallySkippedControls,
    },
  };
  const digest = computeMaestroReplayPlanDigest(planWithoutDigest);
  return freezeDeep({ ...planWithoutDigest, digest });
}

export const buildMaestroReplayPlan = compileMaestroReplayPlan;
export const createMaestroReplayPlan = compileMaestroReplayPlan;

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
    ) as T;
  }
  return value;
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}
