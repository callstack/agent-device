import { expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '../durable-resource-envelope.ts';
import {
  makeDurableCaptureContext,
  testCaptureDefinition,
  testCaptureStore,
  TEST_CAPTURE_KIND,
} from './durable-capture.fixtures.ts';
import { finishRecoveredDurableCapture } from './finish-recovered.ts';

function makeScope() {
  return {
    signal: new AbortController().signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
}

function writeOpenRecord(
  resourcePath: string,
  context: ReturnType<typeof makeDurableCaptureContext>,
) {
  testCaptureStore.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: TEST_CAPTURE_KIND,
      sessionId: context.sessionName,
      device: {
        id: context.device.id,
        family: context.device.platform,
        kind: context.device.kind,
      },
      owner: context.owner,
      fence: context.fence,
      lifecycle: 'open',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
  );
}

/**
 * Descriptor cleanup is destructive, so terminal admission has to decide before it, not after it ran.
 * This stop read the record while it was open and then acquired recovery authority; a live finish
 * committed the record during that window. The stop may not remove what that finish owns, so it settles
 * without cleaning and keeps its own typed refusal.
 */
test('a recovered stop removes nothing from a record that committed while authority was acquired', async () => {
  const context = makeDurableCaptureContext();
  writeOpenRecord(context.resourcePath, context);
  const cleanup = vi.fn(async () => ({ status: 'cleaned' }) as const);

  await expect(
    finishRecoveredDurableCapture(testCaptureDefinition, {
      resourcePath: context.resourcePath,
      scope: makeScope(),
      acquireControl: async () => {
        const record = testCaptureStore.read(context.resourcePath);
        if (record.status !== 'decoded') throw new Error('Expected a decodable record');
        testCaptureStore.write(context.resourcePath, {
          ...record.envelope,
          lifecycle: 'completed',
          metadata: { ...(record.envelope.metadata ?? {}), phase: 'completed' },
        });
        return {
          reattach: async () =>
            ({
              status: 'unreattachable',
              reason: 'transport-not-reattachable',
              message: 'no live control',
            }) as const,
          cleanup,
          [Symbol.asyncDispose]: async () => {},
        };
      },
    }),
  ).rejects.toMatchObject({ details: { reason: 'transport-not-reattachable' } });

  expect(cleanup).not.toHaveBeenCalled();
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});
