import { expect, test } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import {
  makeDurableCaptureContext,
  testCaptureResource,
  testCaptureStore,
} from './durable-capture-resource.fixtures.ts';

test('a nonterminal capture blocks a replacement for the same device in another session', () => {
  const context = makeDurableCaptureContext();
  testCaptureStore.write(
    context.resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: context.sessionName,
      device: { id: context.device.id, family: 'android', kind: 'emulator' },
      owner: context.owner,
      fence: context.fence,
      lifecycle: 'open',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
  );
  const replacementPath = testCaptureStore.resolvePath(
    context.sessionStore.resolveSessionDir('replacement'),
  );

  expect(() =>
    testCaptureResource.createNextFence({
      admissionLedger: context.admissionLedger,
      resourcePath: replacementPath,
      device: context.device,
    }),
  ).toThrow(/terminal state/);
});
