import { expect, test } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createAppleScreenRecordingOperations } from './runtime.ts';
import {
  appleRecordingHost,
  processIdentity,
  recordingInput,
  simulator,
} from './runtime.fixtures.ts';

test('simulator start does not claim that asynchronous compiler work has drained', async () => {
  const host = appleRecordingHost({
    apple: {
      startSimulator: async () => ({
        markers: [processIdentity],
        wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
        terminate: async () => {},
      }),
    },
  });
  const operations = createAppleScreenRecordingOperations({
    host,
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(recordingInput({ claimToken: 'claim' }));
  expect(started.envelope.metadata ?? {}).not.toHaveProperty('recordingCleanupScope');
  await started.pendingHandle[Symbol.asyncDispose]();
});
