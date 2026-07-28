// The provenance mark the runner-timeout setup file writes on a test, and the
// contention retry lane (#1419) reads back through `TestCase.meta()`.

export const RUNNER_TIMEOUT_META = 'agentDeviceRunnerTimeout';

/** True when the runner itself aborted the test with its own timeout error. */
export function runnerTimedOut(meta: unknown): boolean {
  return (meta as Record<string, unknown> | undefined)?.[RUNNER_TIMEOUT_META] === true;
}
