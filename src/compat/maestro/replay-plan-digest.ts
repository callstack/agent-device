import { createHash } from 'node:crypto';
import { canonicalJson } from '../../utils/canonical-json.ts';

export function computeMaestroReplayPlanDigest(plan: {
  readonly platform?: string;
  readonly target?: string;
  readonly runtimeHints?: Readonly<Record<string, unknown>>;
  readonly initialStaticEnv: Readonly<Record<string, unknown>>;
  readonly steps: readonly unknown[];
}): string {
  const canonical = {
    version: 2,
    platform: plan.platform ?? null,
    target: plan.target ?? null,
    runtimeHints: plan.runtimeHints ?? null,
    initialStaticEnv: plan.initialStaticEnv,
    steps: plan.steps,
  };
  return createHash('sha256').update(canonicalJson(canonical), 'utf8').digest('hex');
}
