import { expect, test } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { SCREEN_RECORDING_CLEANUP_SCOPE_METADATA_KEY } from '@agent-device/contracts/screen-recording-runtime';
import { createAppleScreenRecordingOperations } from './runtime.ts';
import {
  appleRecordingHost,
  processIdentity,
  recordingInput,
  simulator,
} from './runtime.fixtures.ts';

test.each(['local-drained', 'unsupported'] as const)(
  'simulator start records only the explicitly proven %s cleanup scope',
  async (scope) => {
    const host = appleRecordingHost({
      apple: {
        cleanupRecoveryScope: async () => scope,
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
    expect(started.envelope.metadata?.[SCREEN_RECORDING_CLEANUP_SCOPE_METADATA_KEY]).toBe(
      scope === 'local-drained' ? scope : undefined,
    );
    await started.pendingHandle[Symbol.asyncDispose]();
  },
);
