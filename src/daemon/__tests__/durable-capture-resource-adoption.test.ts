import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  makeDurableCaptureContext,
  makeDurableCaptureStartResult,
  testCaptureResource,
  testCaptureStore,
} from './durable-capture-resource.fixtures.ts';

test('canceled adoption cleans the pending handle before terminalizing its manifest', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
  const cancellation = new AppError('CANCELED', 'request canceled');

  await expect(
    testCaptureResource.adoptStarted({
      ...context,
      ...start,
      throwIfCanceled: () => {
        throw cancellation;
      },
    }),
  ).rejects.toBe(cancellation);
  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});

test('a failed terminal transition preserves the primary error and blocks replacement', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context, {
    cleanup: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' },
  });
  const primary = new AppError('CANCELED', 'request canceled');
  const resourceDir = path.dirname(context.resourcePath);

  try {
    await expect(
      testCaptureResource.adoptStarted({
        ...context,
        ...start,
        throwIfCanceled: () => {
          fs.chmodSync(resourceDir, 0o500);
          throw primary;
        },
      }),
    ).rejects.toBe(primary);
  } finally {
    fs.chmodSync(resourceDir, 0o700);
  }

  expect(() => context.admissionLedger.assertStartAllowed(context.device)).toThrow(/process-local/);
});
