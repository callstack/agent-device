import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createAppleScreenRecordingOperations } from './runtime.ts';
import {
  appleRecordingHost,
  coreDevice,
  processIdentity,
  recordingInput,
  simulator,
} from './runtime.fixtures.ts';

test('daemon-loss cleanup distinguishes live, dead, replaced, and corrupt simulator identity', async () => {
  const startOperations = createAppleScreenRecordingOperations({
    host: appleRecordingHost({
      apple: {
        startSimulator: async () => ({
          markers: [processIdentity],
          wait: new Promise(() => {}),
          terminate: async () => {},
        }),
      },
    }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const started = await startOperations.screenRecordingStart(recordingInput());
  for (const [ownership, expected, terminations] of [
    ['owned-alive', 'cleaned', 1],
    ['missing', 'already-missing', 0],
    ['ownership-lost', 'cleanup-pending', 0],
  ] as const) {
    const terminateProcess = vi.fn(async () => 'terminated' as const);
    const recovery = createAppleScreenRecordingOperations({
      host: appleRecordingHost({
        apple: { inspectProcess: async () => ownership, terminateProcess },
      }),
      device: simulator,
      owner: localRuntimeOwner('apple'),
      signal: new AbortController().signal,
    });
    await expect(
      recovery.screenRecordingCleanup({ envelope: started.envelope }),
    ).resolves.toMatchObject({ status: expected });
    expect(terminateProcess).toHaveBeenCalledTimes(terminations);
  }

  const inspectProcess = vi.fn(async () => 'owned-alive' as const);
  const corruptEnvelope = {
    ...started.envelope,
    descriptor: {
      ...started.envelope.descriptor,
      body: {
        ...started.envelope.descriptor.body,
        processes: [{ pid: 42, startTime: '', command: processIdentity.command }],
      },
    },
  };
  const corruptRecovery = createAppleScreenRecordingOperations({
    host: appleRecordingHost({ apple: { inspectProcess } }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  await expect(
    corruptRecovery.screenRecordingCleanup({ envelope: corruptEnvelope }),
  ).resolves.toMatchObject({ status: 'cleanup-pending' });
  expect(inspectProcess).not.toHaveBeenCalled();
});

test('runner recovery never stops a replacement session owner', async () => {
  const operations = createAppleScreenRecordingOperations({
    host: appleRecordingHost(),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(recordingInput({ scope: 'app' }));
  const runRunner = vi.fn(async () => ({}));
  const recovery = createAppleScreenRecordingOperations({
    host: appleRecordingHost({
      apple: { inspectRunner: async () => 'ownership-lost', runRunner },
    }),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });

  await expect(
    recovery.screenRecordingCleanup({ envelope: started.envelope }),
  ).resolves.toMatchObject({
    status: 'cleanup-pending',
    reason: 'ownership-fence-lost',
  });
  expect(runRunner).not.toHaveBeenCalled();
});

test.each([
  ['CoreDevice runner without remote path', coreDevice, undefined],
  [
    'macOS runner with remote path',
    { ...coreDevice, appleOs: 'macos' as const, target: 'desktop' as const },
    'tmp/agent-device-recording-123.mp4',
  ],
] as const)(
  'rejects %s descriptor coherence before any ownership side effect',
  async (_name, device, remotePath) => {
    const operations = createAppleScreenRecordingOperations({
      host: appleRecordingHost({
        apple: {
          runRunner: async (_device, request) =>
            request.kind === 'start'
              ? {
                  runnerSessionId: 'runner-session',
                  runnerAuthority: 'local-lease',
                  remotePath: 'tmp/agent-device-recording-123.mp4',
                }
              : {},
        },
      }),
      device: coreDevice,
      owner: localRuntimeOwner('apple'),
      signal: new AbortController().signal,
    });
    const started = await operations.screenRecordingStart(recordingInput({ scope: 'app' }));
    const inspectRunner = vi.fn(async () => 'owned-alive' as const);
    const recovery = createAppleScreenRecordingOperations({
      host: appleRecordingHost({ apple: { inspectRunner } }),
      device,
      owner: localRuntimeOwner('apple'),
      signal: new AbortController().signal,
    });
    const { remotePath: _persistedRemotePath, ...bodyWithoutRemotePath } =
      started.envelope.descriptor.body;
    const envelope = {
      ...started.envelope,
      descriptor: {
        ...started.envelope.descriptor,
        body:
          remotePath === undefined
            ? bodyWithoutRemotePath
            : { ...bodyWithoutRemotePath, remotePath },
      },
    };

    await expect(recovery.screenRecordingReattach({ envelope })).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'descriptor-invalid',
    });
    expect(inspectRunner).not.toHaveBeenCalled();
  },
);
