import { aroundEach } from 'vitest';
import { withCommandHost } from '@agent-device/host-kit/command';

/**
 * Runs every test of the calling suite as a command host whose environment is the live process
 * environment. Test-kit owns the shared helper; capture-kit is a dependency of test-kit, so it
 * keeps this copy local.
 */
export function bindTestCommandHost(): void {
  aroundEach(async (runTest) => {
    await withCommandHost(
      { host: { env: process.env, cwd: process.cwd() }, requestEnv: undefined },
      async () => await runTest(),
    );
  });
}
