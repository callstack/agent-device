import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cleanupRunnerLeasesForOwner: vi.fn(async () => undefined),
}));

vi.mock('@agent-device/platform-apple/runner/operations', () => ({
  cleanupRunnerLeasesForOwner: mocks.cleanupRunnerLeasesForOwner,
}));

import { createDaemonOwnerCleanup } from './platform-runtime-daemon-owner-cleanup.ts';

test('composes owner cleanup with the Apple runner lease facade', async () => {
  const owner = { pid: 42, startTime: 'process-start' };

  await createDaemonOwnerCleanup().cleanup(owner);

  expect(mocks.cleanupRunnerLeasesForOwner).toHaveBeenCalledWith(owner);
});
