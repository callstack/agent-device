import { aroundEach } from 'vitest';
import { withCommandHost } from '@agent-device/host-kit/command';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';

/**
 * A host for tests that boot daemon code in-process. It snapshots the process environment and
 * working directory unless a test names its own, so a suite never shares a mutable reference to
 * `process.env` with the runtime under test.
 */
export function createTestHostEnvironment(
  options: { env?: EnvMap; cwd?: string } = {},
): HostEnvironment {
  return captureHostEnvironment({
    env: options.env ?? process.env,
    cwd: () => options.cwd ?? process.cwd(),
  });
}

/**
 * Runs every test of the calling suite as a command host whose environment is the live process
 * environment, for suites that reach code which reads `commandHostEnvironment()` without going
 * through a daemon request or the CLI entry, which open their own host. Call it once at the top of
 * the suite.
 */
export function bindTestCommandHost(): void {
  aroundEach(async (runTest) => {
    await withCommandHost(
      { host: { env: process.env, cwd: process.cwd() }, requestEnv: undefined },
      async () => await runTest(),
    );
  });
}
