import { expect, test } from 'vitest';
import { countDiagnosticEventsByPhase, withDiagnosticsScope } from '../../utils/diagnostics.ts';
import {
  createTestCaptureResource,
  makeDurableCaptureContext,
  makeDurableCaptureStartResult,
  testCaptureResource,
  testCaptureStore,
} from './durable-capture-resource.fixtures.ts';

test('finish failure remains primary when cleanup and cleanup-pending persistence both fail', async () => {
  const context = makeDurableCaptureContext();
  const finishError = new Error('finalizer failed');
  const cleanupError = new Error('cleanup failed');
  const persistenceError = new Error('cleanup-pending persistence failed');
  const resource = createTestCaptureResource({
    ...testCaptureStore,
    write(resourcePath, envelope) {
      if (envelope.metadata?.phase === 'cleanup-pending') throw persistenceError;
      testCaptureStore.write(resourcePath, envelope);
    },
  });
  const start = makeDurableCaptureStartResult(context, { finishError, cleanupError });
  await resource.adoptStarted({ ...context, ...start, throwIfCanceled: () => {} });
  const active = context.sessionStore.get(context.sessionName);
  if (!active) throw new Error('Expected adopted test capture session');

  await withDiagnosticsScope({ command: 'record' }, async () => {
    await expect(
      resource.finishLive({
        session: active,
        sessionName: context.sessionName,
        sessionStore: context.sessionStore,
      }),
    ).rejects.toBe(finishError);
    expect(countDiagnosticEventsByPhase(['app_log_finish_cleanup_failed'])).toBe(1);
  });
  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(context.sessionStore.get(context.sessionName)?.appLog?.handle).toBe(start.handle);
});

test('an uncertain finish preserves its error after confirmed compensating cleanup', async () => {
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
  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(context.sessionStore.get(context.sessionName)?.appLog).toBeUndefined();
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});

test('an uncertain finish retains live evidence when compensating cleanup is unconfirmed', async () => {
  const context = makeDurableCaptureContext();
  const finishError = new Error('finalizer failed after native stop');
  const start = makeDurableCaptureStartResult(context, {
    finishError,
    cleanup: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' },
  });
  await testCaptureResource.adoptStarted({
    ...context,
    ...start,
    throwIfCanceled: () => {},
  });
  const active = context.sessionStore.get(context.sessionName);
  if (!active) throw new Error('Expected adopted test capture session');

  await withDiagnosticsScope({ command: 'record' }, async () => {
    await expect(
      testCaptureResource.finishLive({
        session: active,
        sessionName: context.sessionName,
        sessionStore: context.sessionStore,
      }),
    ).rejects.toBe(finishError);
    expect(countDiagnosticEventsByPhase(['app_log_finish_cleanup_failed'])).toBe(1);
  });
  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(context.sessionStore.get(context.sessionName)?.appLog?.handle).toBe(start.handle);
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'open',
      metadata: { phase: 'cleanup-pending', cleanupPendingReason: 'cleanup-unconfirmed' },
    },
  });
});
