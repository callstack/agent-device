import { bindTestCommandHost } from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { settleExpiredSession } from '../session-teardown.ts';

bindTestCommandHost();

test('expiry stops at a resource failure so the next pass can retry', async () => {
  const sessionStore = makeSessionStore('agent-device-expired-settle-');
  const ref = sessionStore.publish('default', makeIosSession('default'));
  const finalizeApplication = vi.fn(async () => {});
  const settled = settleExpiredSession({
    appLog: 'run',
    ref,
    sessionStore,
    platformCleanup: platformResourceCleanupFixture({
      stopSnapshotHelper: async () => {
        throw new Error('snapshot helper stop failed');
      },
    }),
    finalizeApplication,
  });

  await expect(settled).rejects.toThrow(/snapshot helper stop failed/);
  expect(finalizeApplication).not.toHaveBeenCalled();
});
