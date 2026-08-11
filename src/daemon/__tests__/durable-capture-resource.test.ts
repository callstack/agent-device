import { expect, test, vi } from 'vitest';
import {
  makeDurableCaptureContext,
  makeDurableCaptureStartResult,
  testCaptureResource,
  testCaptureStore,
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

test('explicit recovery finishes through caller-supplied exact-owner authority', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
  testCaptureStore.write(context.resourcePath, start.envelope);
  const disposeControl = vi.fn(async () => {});

  await expect(
    testCaptureResource.finishRecovered({
      resourcePath: context.resourcePath,
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
      acquireControl: async () => ({
        reattach: async () => ({ status: 'active', handle: start.handle }),
        cleanup: async () => ({ status: 'cleaned' }),
        [Symbol.asyncDispose]: disposeControl,
      }),
    }),
  ).resolves.toMatchObject({ outputPath: '/tmp/app.log', completedAt: 2 });

  expect(start.finish).toHaveBeenCalledOnce();
  expect(disposeControl).toHaveBeenCalledOnce();
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});

test('explicit recovery never converts missing authority into a replacement start', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
  testCaptureStore.write(context.resourcePath, start.envelope);

  await expect(
    testCaptureResource.finishRecovered({
      resourcePath: context.resourcePath,
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
      acquireControl: async () => ({
        reattach: async () => ({ status: 'missing' }),
        cleanup: async () => ({ status: 'already-missing' }),
        [Symbol.asyncDispose]: async () => {},
      }),
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'resource-missing' },
  });
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });
});

test('explicit recovery terminalizes cleanup-safe unreattachable descriptors', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
  testCaptureStore.write(context.resourcePath, start.envelope);
  const cleanup = vi.fn(async () => ({ status: 'cleaned' as const }));

  await expect(
    testCaptureResource.finishRecovered({
      resourcePath: context.resourcePath,
      scope: testScope(),
      acquireControl: async () => ({
        reattach: async () => ({
          status: 'unreattachable',
          reason: 'transport-not-reattachable',
        }),
        cleanup,
        [Symbol.asyncDispose]: async () => {},
      }),
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'transport-not-reattachable' },
  });
  expect(cleanup).toHaveBeenCalledWith(start.envelope);
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});

test('explicit recovery retains ownership-fence failures without attempting cleanup', async () => {
  const context = makeDurableCaptureContext();
  const start = makeDurableCaptureStartResult(context);
  testCaptureStore.write(context.resourcePath, start.envelope);
  const cleanup = vi.fn(async () => ({ status: 'cleaned' as const }));

  await expect(
    testCaptureResource.finishRecovered({
      resourcePath: context.resourcePath,
      scope: testScope(),
      acquireControl: async () => ({
        reattach: async () => ({
          status: 'unreattachable',
          reason: 'ownership-fence-lost',
        }),
        cleanup,
        [Symbol.asyncDispose]: async () => {},
      }),
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'ownership-fence-lost' },
  });
  expect(cleanup).not.toHaveBeenCalled();
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });
});

function testScope() {
  return {
    signal: new AbortController().signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
}
