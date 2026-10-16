import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';

/**
 * A host for tests that boot daemon code in-process. It snapshots the process environment and
 * working directory unless a test names its own, so a suite never shares a mutable reference to
 * `process.env` with the runtime under test.
 */
export function createTestHostEnvironment(
  options: { env?: EnvMap; cwd?: string } = {},
): HostEnvironment {
  return { env: { ...(options.env ?? process.env) }, cwd: options.cwd ?? process.cwd() };
}
