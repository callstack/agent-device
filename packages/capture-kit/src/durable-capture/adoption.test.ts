import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { adoptStartedDurableCapture } from './adoption.ts';
import {
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

test('a failed terminal transition preserves the primary error and reports it unconfirmed', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context, {
    cleanup: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' },
  });
  const primary = new AppError('CANCELED', 'request canceled');
  const resourceDir = path.dirname(context.resourcePath);

  try {
    await expect(
      adoptStartedDurableCapture(
        testCaptureDefinition,
        {
          ...context,
          ...start,
          throwIfCanceled: () => {
            fs.chmodSync(resourceDir, 0o500);
            throw primary;
          },
        },
        context.resourcePath,
      ),
    ).rejects.toBe(primary);
  } finally {
    fs.chmodSync(resourceDir, 0o700);
  }

  expect(context.reportUndurableCleanup).toHaveBeenCalledWith(context.device, {
    confirmed: false,
    reason: expect.stringMatching(/./),
  });
});
