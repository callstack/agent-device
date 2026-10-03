import { bindAppleRunnerHost, type AppleRunnerHost } from './host.ts';

/**
 * Test seam for the package's own suites. The repository's vitest setup for
 * the `apple-runner` project installs the real root host capabilities here, so
 * package tests exercise genuine retry, lock, and exec semantics by default
 * and override individual capabilities per test via
 * {@link appleRunnerTestHost}. Production code never imports this module; the
 * production binding happens in the root composition module instead.
 */

let defaults: AppleRunnerHost | undefined;
let overrides: Partial<AppleRunnerHost> = {};
let bound = false;

export async function loadAppleRunnerHost(): Promise<AppleRunnerHost> {
  return (await import('../core/runner-host.ts')).appleRunnerHost;
}

export function installAppleRunnerTestHost(realHost: AppleRunnerHost): void {
  defaults = realHost;
  overrides = {};
  if (bound) return;
  const dispatcher = new Proxy({} as AppleRunnerHost, {
    get(_target, property: string) {
      return (...args: unknown[]) => {
        const implementation = (overrides[property as keyof AppleRunnerHost] ??
          defaults?.[property as keyof AppleRunnerHost]) as
          | ((...callArgs: unknown[]) => unknown)
          | undefined;
        if (!implementation) {
          throw new Error(`AppleRunnerHost.${property} is not available in this test`);
        }
        return implementation(...args);
      };
    },
  });
  bindAppleRunnerHost(dispatcher);
  bound = true;
}

export const appleRunnerTestHost = {
  /** Overrides individual host capabilities for the current test. */
  update(next: Partial<AppleRunnerHost>): void {
    overrides = { ...overrides, ...next };
  },
  /** Restores the real defaults; the project setup calls this before each test. */
  reset(): void {
    overrides = {};
  },
  /**
   * The installed real capabilities, for overrides that wrap the genuine
   * implementation (calling back through the bound dispatcher would recurse
   * into the override itself).
   */
  defaults(): AppleRunnerHost {
    if (!defaults) throw new Error('Apple runner test host defaults are not installed.');
    return defaults;
  },
};
