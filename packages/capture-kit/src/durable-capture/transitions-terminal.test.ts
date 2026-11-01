import { expect, test, vi } from 'vitest';
import { adoptStartedDurableCapture } from './adoption.ts';
import {
  createTestCaptureDefinition,
  makeDurableCaptureContext,
  makeDurableCaptureStartResult,
  testCaptureDefinition,
  testCaptureStore,
} from './durable-capture.fixtures.ts';
import {
  forceCleanupLiveDurableCapture,
  finishLiveDurableCapture,
  finishDurableCaptureHandle,
} from './transitions.ts';

test.each(['replay', 'refusal'] as const)(
  'a terminal %s disposes the captured handle another handle did not release',
  async (outcome) => {
    const definition = {
      ...testCaptureDefinition,
      completionFromMetadata:
        outcome === 'replay' ? testCaptureDefinition.completionFromMetadata : undefined,
    };
    const { context, captured, completion, record } =
      await captureWhoseRecordAnotherHandleCommitted(definition);
    const dispose = vi.spyOn(captured.handle, Symbol.asyncDispose);

    const finish = finishLiveDurableCapture(
      definition,
      { binding: context.binding, intent: 'disposal' },
      context.resourcePath,
    );
    if (outcome === 'replay') await expect(finish).resolves.toEqual(completion);
    else
      await expect(finish).rejects.toMatchObject({
        details: { reason: 'resource-already-completed' },
      });

    expect(dispose).toHaveBeenCalledOnce();
    expect(captured.forceCleanup).toHaveBeenCalledOnce();
    expect(captured.finish).not.toHaveBeenCalled();
    expect(context.binding.read()).toBeUndefined();
    expect(testCaptureStore.read(context.resourcePath)).toEqual(record);
  },
);

test('a terminal finish reports captured-handle disposal failure instead of a settled refusal', async () => {
  const definition = { ...testCaptureDefinition, completionFromMetadata: undefined };
  const cleanupError = new Error('Captured handle disposal failed');
  const { context, captured, record } = await captureWhoseRecordAnotherHandleCommitted(
    definition,
    cleanupError,
  );

  await expect(
    finishLiveDurableCapture(
      definition,
      { binding: context.binding, intent: 'disposal' },
      context.resourcePath,
    ),
  ).rejects.toBe(cleanupError);
  expect(captured.forceCleanup).toHaveBeenCalledOnce();
  expect(captured.finish).not.toHaveBeenCalled();
  expect(testCaptureStore.read(context.resourcePath)).toEqual(record);
});

async function captureWhoseRecordAnotherHandleCommitted(
  definition: typeof testCaptureDefinition,
  cleanupError?: Error,
) {
  const context = makeDurableCaptureContext();
  const captured = makeDurableCaptureStartResult(context, { cleanupError });
  await adoptStartedDurableCapture(
    definition,
    { ...context, ...captured, throwIfCanceled: () => {} },
    context.resourcePath,
  );
  const committing = makeDurableCaptureStartResult(context);
  const completion = await finishDurableCaptureHandle(definition, {
    handle: committing.handle,
    fence: context.fence,
    resourcePath: context.resourcePath,
    intent: 'capture',
  });
  return { context, captured, completion, record: testCaptureStore.read(context.resourcePath) };
}

/**
 * A cleanup that reaches the fence only after a finish committed the same record. The cleanup had
 * read the session's active resource before that finish, so it holds the fence the record still
 * names; ownership alone must not let it write the record back open. It still signals the handle it
 * captured, because that handle is a native resource of its own that nobody else has disposed.
 */
test('a cleanup queued behind a committed finish leaves the record completed and settles its handle', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
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

  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(start.finish).toHaveBeenCalledOnce();
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
  expect(context.binding.read()).toBeUndefined();
});

/**
 * Two finishes captured the same live resource. The first commits its export; the second reaches the
 * fence after that commit. It previously succeeded by replaying the handle's memoized finish, so a
 * refusal here is a new user-visible failure on a path that already has the export to serve — the
 * teardown path reports it as an unreleased resource. It answers the committed completion and drives
 * the native finish no second time.
 */
test('a finish queued behind a committed finish replays the committed export without re-finishing', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
  await adoptStartedDurableCapture(
    testCaptureDefinition,
    { ...context, ...start, throwIfCanceled: () => {} },
    context.resourcePath,
  );
  const queued = context.binding.read();
  if (!queued) throw new Error('Expected adopted test capture session');

  const first = await finishLiveDurableCapture(
    testCaptureDefinition,
    { binding: context.binding, intent: 'capture' },
    context.resourcePath,
  );

  context.binding.adopt(queued);
  await expect(
    finishLiveDurableCapture(
      testCaptureDefinition,
      { binding: context.binding, intent: 'disposal' },
      context.resourcePath,
    ),
  ).resolves.toEqual(first);
  expect(start.finish).toHaveBeenCalledOnce();
  expect(context.binding.read()).toBeUndefined();
});

/**
 * A failed finish that confirmed its compensating cleanup committed a record with no export in it.
 * Nothing is serveable from it, so the caller keeps its own error rather than a made-up completion.
 */
test('a finish queued behind a commit that produced no export keeps its refusal', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
  await adoptStartedDurableCapture(
    testCaptureDefinition,
    { ...context, ...start, throwIfCanceled: () => {} },
    context.resourcePath,
  );
  const queued = context.binding.read();
  if (!queued) throw new Error('Expected adopted test capture session');
  // A record that committed without ever storing this kind's completion.
  testCaptureStore.write(context.resourcePath, {
    ...(
      testCaptureStore.read(context.resourcePath) as Extract<
        ReturnType<typeof testCaptureStore.read>,
        { status: 'decoded' }
      >
    ).envelope,
    lifecycle: 'completed',
    metadata: { phase: 'completed', cleanupStatus: 'cleaned' },
  });

  await expect(
    finishLiveDurableCapture(
      testCaptureDefinition,
      { binding: context.binding, intent: 'disposal' },
      context.resourcePath,
    ),
  ).rejects.toMatchObject({ details: { reason: 'resource-already-completed' } });
  expect(start.finish).not.toHaveBeenCalled();
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
