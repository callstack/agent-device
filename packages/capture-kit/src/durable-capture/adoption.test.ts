import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { adoptStartedDurableCapture } from './adoption.ts';
import {
  createTestCaptureDefinition,
  makeDurableCaptureContext,
  makeDurableCaptureStartResult,
  testCaptureDefinition,
  testCaptureStore,
} from './durable-capture.fixtures.ts';

test('canceled adoption cleans the pending handle before terminalizing its manifest', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
  const cancellation = new AppError('CANCELED', 'request canceled');

  await expect(
    adoptStartedDurableCapture(
      testCaptureDefinition,
      {
        ...context,
        ...start,
        throwIfCanceled: () => {
          throw cancellation;
        },
      },
      context.resourcePath,
    ),
  ).rejects.toBe(cancellation);
  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
  expect(context.reportUndurableCleanup).toHaveBeenCalledWith(context.device, { confirmed: true });
});

test('canceled adoption terminalizes its manifest when the session retires during cleanup', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
  let releaseCleanup!: () => void;
  let enterCleanup!: () => void;
  const heldCleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const cleanupEntered = new Promise<void>((resolve) => {
    enterCleanup = resolve;
  });
  start.forceCleanup.mockImplementationOnce(async () => {
    enterCleanup();
    await heldCleanup;
    return { status: 'cleaned' } as const;
  });
  const cancellation = new AppError('CANCELED', 'request canceled');
  const adoption = adoptStartedDurableCapture(
    testCaptureDefinition,
    {
      ...context,
      ...start,
      throwIfCanceled: () => {
        throw cancellation;
      },
    },
    context.resourcePath,
  );
  const rejected = expect(adoption).rejects.toBe(cancellation);

  await cleanupEntered;
  const original = context.sessionStore.lookup(context.sessionName);
  expect(context.sessionStore.retire(original)).toBe(true);
  const successor = { name: 'successor' };
  context.sessionStore.set(context.sessionName, successor);
  releaseCleanup();
  await rejected;

  expect(context.sessionStore.get(context.sessionName)).toBe(successor);
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
  expect(context.reportUndurableCleanup).toHaveBeenCalledWith(context.device, { confirmed: true });
});

test('a failed terminal transition preserves the primary error and reports it unconfirmed', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context, {
    cleanup: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' },
  });
  const primary = new AppError('CANCELED', 'request canceled');
  let writesFail = false;
  const definition = createTestCaptureDefinition({
    ...testCaptureStore,
    write: (resourcePath, envelope) => {
      if (writesFail) throw Object.assign(new Error('test write denied'), { code: 'EACCES' });
      testCaptureStore.write(resourcePath, envelope);
    },
  });

  await expect(
    adoptStartedDurableCapture(
      definition,
      {
        ...context,
        ...start,
        throwIfCanceled: () => {
          writesFail = true;
          throw primary;
        },
      },
      context.resourcePath,
    ),
  ).rejects.toBe(primary);

  expect(context.reportUndurableCleanup).toHaveBeenCalledWith(context.device, {
    confirmed: false,
    reason: 'Test capture cleanup could not be confirmed',
  });
});

test('adoption refuses a retired lifetime even when its address has a vacant successor', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
  context.sessionStore.retire(context.sessionStore.lookup(context.sessionName));
  const successor = { name: 'successor' };
  context.sessionStore.set(context.sessionName, successor);
  await expect(
    adoptStartedDurableCapture(
      testCaptureDefinition,
      {
        ...context,
        ...start,
        throwIfCanceled: () => {},
      },
      context.resourcePath,
    ),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(context.sessionStore.get(context.sessionName)).toBe(successor);
  expect(testCaptureStore.read(context.resourcePath).status).toBe('missing');
  expect(context.reportUndurableCleanup).toHaveBeenCalledWith(context.device, { confirmed: true });
});
