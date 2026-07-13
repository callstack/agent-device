import { createHash } from 'node:crypto';

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
  return createHash('sha256')
    .update(JSON.stringify(sortKeysDeep(canonical)), 'utf8')
    .digest('hex');
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = sortKeysDeep(record[key]);
  return sorted;
}
