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
