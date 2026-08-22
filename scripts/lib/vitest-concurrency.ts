import os from 'node:os';

/**
 * Keep one Vitest invocation modest enough to coexist with two other Codex
 * worktrees on a 12-core development host: 3 agents + (3 suites * 2 workers)
 * leaves roughly 3 cores for runners, subprocesses, simulators, and the OS.
 */
export const DEFAULT_VITEST_MAX_WORKERS = 2;

/**
 * Opt-in escape hatch for a solo local run that owns the whole machine (see
 * docs/agents/testing.md). Ignored in CI, which already derives its own
 * worker count from the isolated runner's CPU pool.
 */
export const VITEST_MAX_WORKERS_OVERRIDE_ENV = 'AGENT_DEVICE_VITEST_MAX_WORKERS';

export function resolveVitestMaxWorkers(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (env.CI === 'true') return undefined;

  const override = parsePositiveInt(env[VITEST_MAX_WORKERS_OVERRIDE_ENV]);
  // Clamp rather than trust the override literally: a typo like `999` must not
  // oversubscribe the host the way the default cap above exists to prevent.
  // availableParallelism(), not cpus().length: Node documents the latter as
  // unfit for sizing parallelism because it ignores CPU affinity and cgroup
  // limits, which would inflate the ceiling this clamp exists to enforce.
  if (override !== undefined) return Math.min(override, os.availableParallelism());

  return DEFAULT_VITEST_MAX_WORKERS;
}

// A missing, blank, non-numeric, non-integer, or non-positive value falls
// through to the default cap instead of throwing or coercing to something
// surprising (e.g. `Number('')` is 0, not NaN).
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
