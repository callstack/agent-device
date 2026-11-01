import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createDurableResourceEnvelope } from '../durable-resource-envelope.ts';
import {
  makeDurableCaptureContext,
  testCaptureDefinition,
  testCaptureStore,
  TEST_CAPTURE_KIND,
} from './durable-capture.fixtures.ts';
import { recoverDurableCaptureResourcesAfterDaemonLock } from './recovery.ts';

test('generic recovery terminalizes missing native authority through one exact control', async () => {
  const context = makeDurableCaptureContext();
  testCaptureStore.write(
    context.resourcePath,
    createDurableResourceEnvelope({
      resourceKind: TEST_CAPTURE_KIND,
      sessionId: context.sessionName,
      device: { id: 'emulator-5554', family: 'android', kind: 'emulator' },
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
  );
  const dispose = vi.fn(async () => {});

  await expect(
    recoverDurableCaptureResourcesAfterDaemonLock({
      definition: testCaptureDefinition,
      sessionsDir: context.sessionsDir,
      resolveSessionDir: context.resolveSessionDir,
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
      acquireControl: async () => ({
        reattach: async () => ({ status: 'missing' }),
        cleanup: async () => ({ status: 'already-missing' }),
        [Symbol.asyncDispose]: dispose,
      }),
    }),
  ).resolves.toEqual({ scanned: 1, recovered: 1, retained: 0 });
  expect(dispose).toHaveBeenCalledOnce();
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'completed',
      metadata: { phase: 'completed', recoveryStatus: 'already-missing' },
    },
  });
});

/**
 * Descriptor cleanup is destructive, so terminal admission has to decide before it, not after it ran.
 * Recovery read the record while it was open, then acquired authority; a finish committed the record
 * during that window. Nothing may be removed from a committed record, so this attempt settles without
 * touching the descriptor the committing finish owns.
 */
test('generic recovery removes nothing from a record that committed while authority was acquired', async () => {
  const context = makeDurableCaptureContext();
  testCaptureStore.write(
    context.resourcePath,
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
  const cleanup = vi.fn(async () => ({ status: 'cleaned' }) as const);

  await expect(
    recoverDurableCaptureResourcesAfterDaemonLock({
      definition: testCaptureDefinition,
      sessionsDir: context.sessionsDir,
      resolveSessionDir: context.resolveSessionDir,
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
      acquireControl: async () => {
        // Another caller commits while this recovery holds authority and has not cleaned yet.
        commitCommittedRecord(context.resourcePath);
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
  ).resolves.toEqual({ scanned: 1, recovered: 1, retained: 0 });

  expect(cleanup).not.toHaveBeenCalled();
  expect(testCaptureStore.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
});

/** Commits the record a recovery is working on, through the same fence that record names. */
function commitCommittedRecord(resourcePath: string): void {
  const record = testCaptureStore.read(resourcePath);
  if (record.status !== 'decoded') throw new Error('Expected a decodable test capture record');
  testCaptureStore.write(resourcePath, {
    ...record.envelope,
    lifecycle: 'completed',
    metadata: { ...(record.envelope.metadata ?? {}), phase: 'completed' },
  });
}
