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

test.each(['fence', 'handle', 'vacant'] as const)(
  'failed clear retains its latest observed %s slot after retirement',
  async (change) => {
    const context = makeDurableCaptureContext();
    const start = makeDurableCaptureStartResult(context);
    await adoptStartedDurableCapture(
      testCaptureDefinition,
      { ...context, ...start, throwIfCanceled: () => {} },
      context.resourcePath,
    );
    const original = context.binding.read()!;
    const replacement =
      change === 'vacant'
        ? undefined
        : change === 'handle'
          ? { ...original, handle: makeDurableCaptureStartResult(context).handle }
          : {
              ...original,
              envelope: {
                ...original.envelope,
                fence: {
                  ...original.envelope.fence,
                  generation: original.envelope.fence.generation + 1,
                },
              },
            };
    context.sessions.set(context.sessionName, {
      ...context.sessions.get(context.sessionName)!,
      capture: replacement,
    });
    expect(context.binding.clear(original)).toBe('resource-changed');
    context.sessions.retire(context.sessions.lookup(context.sessionName));
    expect(context.binding.read()).toBe(replacement);
  },
);
