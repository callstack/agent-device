import { vi } from 'vitest';

// Stubs the Android freshness-retry delay (`sleep`) to a no-op so a sibling that
// exercises a retry BRANCH runs it without a real wall-clock wait, per the repo rule
// against real-time sleeps in unit tests. Making `sleep` instant does not change
// control flow — the loop still runs, retries, and re-captures — so a test still
// proves the retried tree and dispatch count. It is a separate module imported
// BEFORE `session-replay-divergence.fixtures.ts` (which loads the SUT under the
// interactor/dispatch mocks) because the SUT binds `sleep` at import time: this mock
// must be registered first. Keeping it out of the shared fixtures stops it from
// silently no-oping the retry delay in siblings that never retry.
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});
