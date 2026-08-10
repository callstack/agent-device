/**
 * Keep one Vitest invocation modest enough to coexist with two other Codex
 * worktrees on a 12-core development host: 3 agents + (3 suites * 2 workers)
 * leaves roughly 3 cores for runners, subprocesses, simulators, and the OS.
 */
export const DEFAULT_VITEST_MAX_WORKERS = 2;

export function resolveVitestMaxWorkers(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return env.CI === 'true' ? undefined : DEFAULT_VITEST_MAX_WORKERS;
}
