import { expect, test } from 'vitest';
import {
  makeDurableCaptureContext,
  makeDurableCaptureStartResult,
  testCaptureResource,
} from './durable-capture-resource.fixtures.ts';

test('one coordinator exposes the typed manifest and all lifecycle entrypoints', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);

  await testCaptureResource.adoptStarted({
    ...context,
    ...start,
    throwIfCanceled: () => {},
  });
  const active = context.sessionStore.get(context.sessionName);
  expect(active?.appLog?.handle).toBe(start.handle);
  if (!active) throw new Error('Expected adopted test capture session');

  await expect(
    testCaptureResource.finishLive({
      session: active,
      sessionName: context.sessionName,
      sessionStore: context.sessionStore,
    }),
  ).resolves.toMatchObject({ outputPath: '/tmp/app.log', completedAt: 2 });
  expect(context.sessionStore.get(context.sessionName)?.appLog).toBeUndefined();
});
