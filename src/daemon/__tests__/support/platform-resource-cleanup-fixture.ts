import { vi, type Mock } from 'vitest';
import type { PlatformResourceCleanup } from '../../platform-resource-cleanup.ts';

/** Every member observable as a spy, which is how the daemon suites read the fixture back. */
export type PlatformResourceCleanupFixture = {
  [K in keyof PlatformResourceCleanup]: Mock<PlatformResourceCleanup[K]>;
};

/**
 * The `PlatformResourceCleanup` port as the daemon suites need it. Daemon tests assert which
 * finalization the neutral orchestration asked for and with which arguments — snapshot-helper
 * stop on close, managed-browser close on web teardown, host retention on shutdown — never how
 * a platform performs it; the concrete snapshot-helper, managed-browser, and runner-host
 * teardown mechanics belong to the platform packages and are asserted root-owned under
 * `src/__tests__/daemon-composition/`. Each member is a `vi.fn`, so a suite both injects and
 * observes it: read calls off the returned members. An override replaces one capability's
 * behavior (a rejection, a specific retention answer) and stays spy-visible — the same shape
 * production wiring takes when it composes a different capability.
 */
export function platformResourceCleanupFixture(
  overrides: Partial<PlatformResourceCleanup> = {},
): PlatformResourceCleanupFixture {
  return Object.freeze({
    stopSnapshotHelper: vi.fn(overrides.stopSnapshotHelper ?? (async () => {})),
    closeManagedBrowser: vi.fn(overrides.closeManagedBrowser ?? (async () => {})),
    cleanupSessionlessExecutionHost: vi.fn(
      overrides.cleanupSessionlessExecutionHost ?? (async () => {}),
    ),
    retainExecutionHostAfterClose: vi.fn(overrides.retainExecutionHostAfterClose ?? (() => false)),
  }) as PlatformResourceCleanupFixture;
}
