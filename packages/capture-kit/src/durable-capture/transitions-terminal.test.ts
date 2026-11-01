import { expect, test } from 'vitest';
import { adoptStartedDurableCapture } from './adoption.ts';
import {
  createTestCaptureDefinition,
  makeDurableCaptureContext,
  makeDurableCaptureStartResult,
  testCaptureDefinition,
  testCaptureStore,
} from './durable-capture.fixtures.ts';
import { forceCleanupLiveDurableCapture, finishLiveDurableCapture } from './transitions.ts';

/**
 * A cleanup that reaches the fence only after a finish committed the same record. The cleanup had
 * read the session's active resource before that finish, so it holds the fence the record still
 * names; ownership alone must not let it write the record back open or dispose a committed export.
 */
test('a cleanup queued behind a committed finish leaves the record completed and cleans nothing', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context, {
    cleanup: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' },
  });
  await adoptStartedDurableCapture(
    testCaptureDefinition,
    { ...context, ...start, throwIfCanceled: () => {} },
    context.resourcePath,
  );
  // The queued cleanup's own view of the session, captured while the record was still open.
  const queued = context.binding.read();
  if (!queued) throw new Error('Expected adopted test capture session');

  await finishLiveDurableCapture(
    testCaptureDefinition,
    { binding: context.binding, intent: 'capture' },
    context.resourcePath,
  );
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });

  // The queued cleanup now reaches the same slot and the same fence its record still names.
  context.binding.adopt(queued);
  await forceCleanupLiveDurableCapture(testCaptureDefinition, {
    binding: context.binding,
    resourcePath: context.resourcePath,
  });

  expect(start.forceCleanup).not.toHaveBeenCalled();
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});

/**
 * A failed export under a preserving kind has to be drivable again: the retry reads the open record
 * and its journaled facts. Terminal admission must not treat an in-flight attempt as terminal.
 */
test('a failed export under a preserving kind stays retryable through the same fence', async () => {
  const context = makeDurableCaptureContext();
  const definition = createTestCaptureDefinition(testCaptureStore, 'preserve-retry-material');
  const start = makeDurableCaptureStartResult(context, {
    finishError: new Error('collect failed'),
  });
  await adoptStartedDurableCapture(
    definition,
    { ...context, ...start, throwIfCanceled: () => {} },
    context.resourcePath,
  );

  await expect(
    finishLiveDurableCapture(
      definition,
      { binding: context.binding, intent: 'capture' },
      context.resourcePath,
    ),
  ).rejects.toThrow('collect failed');
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'completing' } },
  });
  expect(context.binding.read()).toBeDefined();

  // The same live handle drives the stop again, and this time its export commits.
  start.finish.mockImplementationOnce(async () => ({
    status: 'completed',
    result: { outputPath: '/tmp/capture', completedAt: 3 },
  }));
  await expect(
    finishLiveDurableCapture(
      definition,
      { binding: context.binding, intent: 'capture' },
      context.resourcePath,
    ),
  ).resolves.toMatchObject({ outputPath: '/tmp/capture', completedAt: 3 });
  expect(start.forceCleanup).not.toHaveBeenCalled();
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});
