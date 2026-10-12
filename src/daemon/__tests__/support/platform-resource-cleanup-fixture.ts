import { vi } from 'vitest';
import type { PlatformResourceCleanup } from '../../platform-resource-cleanup.ts';

/**
 * The `PlatformResourceCleanup` port as the daemon suites need it. Daemon tests assert which
 * finalization the neutral orchestration asked for and with which arguments — snapshot-helper
 * stop on close, managed-browser close on web teardown, host retention on shutdown — never how
 * a platform performs it; the concrete snapshot-helper, managed-browser, and runner-host
 * teardown mechanics belong to the platform packages. A suite that needs a failure or a
 * specific answer overrides the single member it cares about, the same way production wiring
 * replaces one composed capability.
 */
export function platformResourceCleanupFixture(
  overrides: Partial<PlatformResourceCleanup> = {},
): PlatformResourceCleanup {
  return Object.freeze({
    stopSnapshotHelper: vi.fn(async () => {}),
    closeManagedBrowser: vi.fn(async () => {}),
    cleanupSessionlessExecutionHost: vi.fn(async () => {}),
    retainExecutionHostAfterClose: vi.fn(() => false),
    ...overrides,
  });
}

/**
 * The shared no-op cleanup for suites that only need the capability to exist and never assert
 * on it. Prefer {@link platformResourceCleanupFixture} per test when the suite observes calls.
 */
export const noopPlatformResourceCleanup: PlatformResourceCleanup = Object.freeze({
  stopSnapshotHelper: async () => {},
  closeManagedBrowser: async () => {},
  cleanupSessionlessExecutionHost: async () => {},
  retainExecutionHostAfterClose: () => false,
});
