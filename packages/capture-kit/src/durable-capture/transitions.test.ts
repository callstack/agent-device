import { expect, test } from 'vitest';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { adoptStartedDurableCapture } from './adoption.ts';
import {
  createTestCaptureDefinition,
  makeDurableCaptureContext,
  makeDurableCaptureStartResult,
  testCaptureDefinition,
  testCaptureStore,
} from './durable-capture.fixtures.ts';
import { finishLiveDurableCapture } from './transitions.ts';

test('finish failure remains primary when cleanup and cleanup-pending persistence both fail', async () => {
  const context = makeDurableCaptureContext();
  const finishError = new Error('finalizer failed');
  const cleanupError = new Error('cleanup failed');
  const persistenceError = new Error('cleanup-pending persistence failed');
  const definition = createTestCaptureDefinition({
    ...testCaptureStore,
    write(resourcePath, envelope) {
      if (envelope.metadata?.phase === 'cleanup-pending') throw persistenceError;
      testCaptureStore.write(resourcePath, envelope);
    },
  });
  const start = makeDurableCaptureStartResult(context, { finishError, cleanupError });
  await adoptStartedDurableCapture(
    definition,
    { ...context, ...start, throwIfCanceled: () => {} },
    context.resourcePath,
  );
  const active = context.sessions.get(context.sessionName);
  if (!active) throw new Error('Expected adopted test capture session');

  await withDiagnosticsScope({ command: 'record' }, async () => {
    await expect(
      finishLiveDurableCapture(
        definition,
        { session: active, sessionName: context.sessionName, sessionStore: context.sessionStore },
        context.resourcePath,
      ),
    ).rejects.toBe(finishError);
    expect(countDiagnosticEventsByPhase(['test_capture_finish_cleanup_failed'])).toBe(1);
  });
  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(context.sessions.get(context.sessionName)?.capture?.handle).toBe(start.handle);
});

test('an uncertain finish preserves its error after confirmed compensating cleanup', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context, {
    finish: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' },
  });
  await adoptStartedDurableCapture(
    testCaptureDefinition,
    { ...context, ...start, throwIfCanceled: () => {} },
    context.resourcePath,
  );
  const active = context.sessions.get(context.sessionName);
  if (!active) throw new Error('Expected adopted test capture session');

  await expect(
    finishLiveDurableCapture(
      testCaptureDefinition,
      { session: active, sessionName: context.sessionName, sessionStore: context.sessionStore },
      context.resourcePath,
    ),
  ).rejects.toMatchObject({ details: { reason: 'cleanup-unconfirmed' } });
  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(context.sessions.get(context.sessionName)?.capture).toBeUndefined();
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
  await adoptStartedDurableCapture(
    testCaptureDefinition,
    { ...context, ...start, throwIfCanceled: () => {} },
    context.resourcePath,
  );
  const active = context.sessions.get(context.sessionName);
  if (!active) throw new Error('Expected adopted test capture session');

  await withDiagnosticsScope({ command: 'record' }, async () => {
    await expect(
      finishLiveDurableCapture(
        testCaptureDefinition,
        { session: active, sessionName: context.sessionName, sessionStore: context.sessionStore },
        context.resourcePath,
      ),
    ).rejects.toBe(finishError);
    expect(countDiagnosticEventsByPhase(['test_capture_finish_cleanup_failed'])).toBe(1);
  });
  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(context.sessions.get(context.sessionName)?.capture?.handle).toBe(start.handle);
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'open',
      metadata: { phase: 'cleanup-pending', cleanupPendingReason: 'cleanup-unconfirmed' },
    },
  });
});
