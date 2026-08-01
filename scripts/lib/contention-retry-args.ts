// Vitest argv for the two runs of the contention retry lane (#1419). The retry
// must execute the failed files the same way the first run did — same projects,
// same V8 instrumentation — or a failure the Coverage job produced could be
// accepted by a run that could not reproduce it.

export type RunModes = { projects: readonly string[]; coverage: boolean };

/** Where the retry's own coverage lands, so the first run's report stays the gate's evidence. */
export const RETRY_COVERAGE_DIR = 'coverage/contention-retry';

function projectArgs(modes: RunModes): string[] {
  return modes.projects.flatMap((name) => ['--project', name]);
}

export function firstRunArgs(modes: RunModes): string[] {
  return [...projectArgs(modes), ...(modes.coverage ? ['--coverage'] : [])];
}

export function retryRunArgs(modes: RunModes, files: readonly string[]): string[] {
  if (!modes.coverage) return [...projectArgs(modes), ...files];
  // Global thresholds describe the whole suite; a handful of files can never meet
  // them. A first-run threshold failure is a blocker, so the retry never runs.
  return [
    ...projectArgs(modes),
    '--coverage',
    `--coverage.reportsDirectory=${RETRY_COVERAGE_DIR}`,
    '--coverage.thresholds.statements=0',
    '--coverage.thresholds.lines=0',
    ...files,
  ];
}
