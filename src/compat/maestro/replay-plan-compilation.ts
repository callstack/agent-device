import { computeMaestroReplayPlanDigest } from './replay-plan-digest.ts';
import type { MaestroProgram } from './program-ir.ts';
import { compileMaestroReplayPlanSteps } from './replay-plan-steps.ts';
import type { MaestroReplayPlan, MaestroReplayPlanOptions } from './replay-plan-types.ts';
import type { SessionRuntimeHints } from '../../kernel/contracts.ts';
import { stripUndefined } from '../../utils/parsing.ts';

export async function compileMaestroReplayPlan(
  program: MaestroProgram,
  options: MaestroReplayPlanOptions = {},
): Promise<MaestroReplayPlan> {
  const { steps, staticallyExecutedControls, staticallySkippedControls } =
    await compileMaestroReplayPlanSteps(program, options);
  const runtimeHints = normalizeRuntimeHints(options.runtimeHints);
  const planWithoutDigest = stripUndefined({
    kind: 'maestroReplayPlan' as const,
    platform: options.platform,
    target: options.target,
    runtimeHints,
    initialStaticEnv: structuredClone({
      ...(options.defaults ?? {}),
      ...(program.config.env ?? {}),
      ...(options.env ?? {}),
    }),
    steps: structuredClone(steps),
    total: steps.length,
    compatibility: {
      staticallyExecutedControls,
      staticallySkippedControls,
    },
  });
  const digest = computeMaestroReplayPlanDigest(planWithoutDigest);
  return freezeDeep({ ...planWithoutDigest, digest });
}

function normalizeRuntimeHints(
  hints: Readonly<SessionRuntimeHints> | undefined,
): Readonly<SessionRuntimeHints> | undefined {
  if (!hints) return undefined;
  const entries = Object.entries(hints).filter((entry) => entry[1] !== undefined);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}
