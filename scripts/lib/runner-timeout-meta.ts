// The provenance mark the runner-timeout setup file writes on a test, and the
// contention retry lane (#1419) reads back through `TestCase.meta()`.
//
// `task.meta` is writable by test code, so the mark is not a boolean but a
// per-run secret the lane generates. Setup files are imported before any test
// module, and the setup file takes the secret out of the environment as it
// loads, so no test body can read the value it would have to forge.

export const RUNNER_TIMEOUT_META = 'agentDeviceRunnerTimeout';

export const RUNNER_TIMEOUT_TOKEN_ENV = 'CONTENTION_RETRY_TIMEOUT_TOKEN';

/** Reads the run's secret and removes it from `env`, leaving nothing for a test to find. */
export function takeRunnerTimeoutToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env[RUNNER_TIMEOUT_TOKEN_ENV];
  delete env[RUNNER_TIMEOUT_TOKEN_ENV];
  return token;
}

/** True when the runner itself aborted the test with its own timeout error. */
export function runnerTimedOut(meta: unknown, token: string | undefined): boolean {
  if (!token) return false;
  return (meta as Record<string, unknown> | undefined)?.[RUNNER_TIMEOUT_META] === token;
}
