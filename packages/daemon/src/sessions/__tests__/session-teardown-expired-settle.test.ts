import { bindTestCommandHost } from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { settleExpiredSession } from '../session-teardown.ts';

bindTestCommandHost();

function settleWithFailingResources(afterResourceFailure: 'stop' | 'finalize') {
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
    afterResourceFailure,
    finalizeApplication,
  });
  return { settled, finalizeApplication };
}

test('a lease expiry still finalizes the application after a resource failure, which stays the error', async () => {
  const { settled, finalizeApplication } = settleWithFailingResources('finalize');

  await expect(settled).rejects.toThrow(/snapshot helper stop failed/);
  expect(finalizeApplication).toHaveBeenCalledTimes(1);
});

test('an idle expiry stops at a resource failure, so the next pass can retry', async () => {
  const { settled, finalizeApplication } = settleWithFailingResources('stop');

  await expect(settled).rejects.toThrow(/snapshot helper stop failed/);
  expect(finalizeApplication).not.toHaveBeenCalled();
});
