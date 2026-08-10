import { expect, test } from 'vitest';
import {
  makeDurableCaptureContext,
  makeDurableCaptureStartResult,
  testCaptureResource,
  testCaptureStore,
} from './durable-capture-resource.fixtures.ts';

test('an uncertain finish retains both the live slot and cleanup-pending durable truth', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context, {
    finish: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' },
  });
  await testCaptureResource.adoptStarted({
    ...context,
    ...start,
    throwIfCanceled: () => {},
  });
  const active = context.sessionStore.get(context.sessionName);
  if (!active) throw new Error('Expected adopted test capture session');

  await expect(
    testCaptureResource.finishLive({
      session: active,
      sessionName: context.sessionName,
      sessionStore: context.sessionStore,
    }),
  ).rejects.toMatchObject({ details: { reason: 'cleanup-unconfirmed' } });
  expect(context.sessionStore.get(context.sessionName)?.appLog?.handle).toBe(start.handle);
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'cleanup-pending' } },
  });
});
