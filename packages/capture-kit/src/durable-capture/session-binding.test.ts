import { expect, test, vi } from 'vitest';
import { adoptStartedDurableCapture } from './adoption.ts';
import {
  makeDurableCaptureContext,
  makeDurableCaptureStartResult,
  testCaptureDefinition,
} from './durable-capture.fixtures.ts';
import { createDurableCaptureSessionBinding } from './session-binding.ts';

test('closed admission refuses adoption before writing or retaining the resource', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
  await adoptStartedDurableCapture(
    testCaptureDefinition,
    { ...context, ...start, throwIfCanceled: () => {} },
    context.resourcePath,
  );
  const resource = context.binding.read()!;
  const session = { capture: undefined };
  const write = vi.fn();
  const refusal = new Error('admission closed');
  const binding = createDurableCaptureSessionBinding({
    address: context.binding.address,
    sessionDir: context.binding.sessionDir,
    initialSession: session,
    resolveCurrent: () => session,
    requireCurrent: () => session,
    assertAdmissionOpen: () => {
      throw refusal;
    },
    read: (current) => current.capture,
    write,
  });
  expect(() => binding.adopt(resource)).toThrow(refusal);
  expect(write).not.toHaveBeenCalled();
  expect(binding.read()).toBeUndefined();
});
