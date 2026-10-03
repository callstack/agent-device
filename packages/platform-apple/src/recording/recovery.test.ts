import { expect, test, vi } from 'vitest';
import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { recordingFileStore } from '@agent-device/capture-kit/recording-artifact-fixtures';
import {
  collectedRecordingPath,
  nativeRecordingPath,
} from '@agent-device/capture-kit/recording-stop-sequence';
import type { JsonObject } from '@agent-device/contracts/client';
import { createAppleScreenRecordingOperations } from './runtime.ts';
import {
  appleRecordingHost,
  coreDevice,
  processIdentity,
  recordingInput,
  recordingOutputPath,
  simulator,
  simulatorRecorderStart,
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

type SimulatorHostOptions = Parameters<typeof appleRecordingHost>[0];

function simulatorHost(
  files: ReturnType<typeof recordingFileStore>,
  extra: SimulatorHostOptions = {},
) {
  return appleRecordingHost({
    ...extra,
    files,
    apple: {
      ...simulatorRecorderStart(),
      inspectProcess: async () => 'missing' as const,
      ...extra.apple,
    },
  });
}

function recoveryOperations(host: ReturnType<typeof appleRecordingHost>) {
  return createAppleScreenRecordingOperations({
    host,
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
}

async function startSimulatorRecording(
  files: ReturnType<typeof recordingFileStore>,
  overrides: Parameters<typeof recordingInput>[0] = {},
) {
  return await recoveryOperations(simulatorHost(files)).screenRecordingStart(
    recordingInput(overrides),
  );
}

test('a simulator recording whose recorder died with its daemon exports through the retried stop', async () => {
  const files = recordingFileStore();
  const started = await startSimulatorRecording(files);
  const nativePath = nativeRecordingPath(recordingOutputPath());

  const reattached = await recoveryOperations(simulatorHost(files)).screenRecordingReattach({
    envelope: started.envelope,
  });
  expect(reattached).toMatchObject({ status: 'active' });
  if (reattached.status !== 'active') throw new Error('expected an exportable recording');

  await expect(reattached.handle.finish()).resolves.toMatchObject({
    status: 'completed',
    result: {
      backend: 'simctl recordVideo',
      outPath: recordingOutputPath(),
      scope: 'device',
      stopObservation: { recorder: 'confirmed' },
      nativePathDisposition: 'retired',
    },
  });
  expect(files.exists(recordingOutputPath())).toBe(true);
  expect(files.exists(nativePath)).toBe(false);
});

test('a finalized export whose daemon died before the record closed still completes', async () => {
  // What the first attempt left behind: the export it wrote, the recorder's file it retired, and the
  // copy it discarded once the finalization below was journaled.
  const files = recordingFileStore({ [recordingOutputPath()]: 'fake-video' });
  const started = await startSimulatorRecording(files);
  await files.outputs.remove(nativeRecordingPath(recordingOutputPath()));
  const complete = vi.fn(async () => ({}));
  const envelope = stopJournalOn(started.envelope, {
    stopObservation: { recorder: 'confirmed' },
    stoppedAtMs: 1_790_000_000_000,
    collectedPath: collectedRecordingPath(recordingOutputPath()),
    exportPath: recordingOutputPath(),
    stopFinalization: {
      telemetryPath: '/tmp/capture.gesture-telemetry.json',
      nativePathDisposition: 'retired',
    },
  });

  const reattached = await recoveryOperations(
    simulatorHost(files, { complete }),
  ).screenRecordingReattach({ envelope });
  if (reattached.status !== 'active') throw new Error('expected a finalized export to replay');

  await expect(reattached.handle.finish(stopProgressFor(envelope))).resolves.toMatchObject({
    status: 'completed',
    result: {
      outPath: recordingOutputPath(),
      telemetryPath: '/tmp/capture.gesture-telemetry.json',
      stopObservation: { recorder: 'confirmed' },
      nativePathDisposition: 'retired',
    },
  });
  // The export was written by the stop that journaled it, so nothing here re-runs the finalizer.
  expect(complete).not.toHaveBeenCalled();
});

test('a collected copy is finalized again when the recorder no longer has its own file', async () => {
  const files = recordingFileStore();
  const started = await startSimulatorRecording(files);
  const collectedPath = collectedRecordingPath(recordingOutputPath());
  await files.outputs.copy({ from: nativeRecordingPath(recordingOutputPath()), to: collectedPath });
  await files.outputs.remove(nativeRecordingPath(recordingOutputPath()));
  const copy = vi.fn(async ({ from, to }: Readonly<{ from: string; to: string }>) => {
    const bytes = files.files.get(from);
    if (bytes === undefined) throw new Error(`ENOENT: ${from}`);
    files.files.set(to, bytes);
  });
  const complete = vi.fn(async () => ({
    telemetryPath: '/tmp/capture.gesture-telemetry.json',
  }));
  const envelope = stopJournalOn(started.envelope, {
    stopObservation: { recorder: 'confirmed' },
    stoppedAtMs: 1_790_000_000_000,
    collectedPath,
  });

  const reattached = await recoveryOperations(
    simulatorHost(files, { complete, outputs: { copy } }),
  ).screenRecordingReattach({ envelope });
  if (reattached.status !== 'active') throw new Error('expected a collectable copy to finish');

  await expect(reattached.handle.finish(stopProgressFor(envelope))).resolves.toMatchObject({
    status: 'completed',
    result: {
      outPath: recordingOutputPath(),
      telemetryPath: '/tmp/capture.gesture-telemetry.json',
      stopObservation: { recorder: 'confirmed' },
    },
  });
  expect(files.exists(recordingOutputPath())).toBe(true);
  // The recorder's own file is gone. A stop that collected again would fail on its way to an export the
  // manifest already describes.
  expect(copy.mock.calls.map(([attempt]) => attempt.from)).toEqual([collectedPath]);
});

test('a journaled copy that cannot be read is answered as a loss instead of a fresh collect', async () => {
  const started = await startSimulatorRecording(recordingFileStore());

  await expect(
    recoveryOperations(simulatorHost(recordingFileStore())).screenRecordingReattach({
      envelope: stopJournalOn(started.envelope, {
        stopObservation: { recorder: 'confirmed' },
        collectedPath: collectedRecordingPath(recordingOutputPath()),
      }),
    }),
  ).resolves.toEqual({ status: 'missing' });
});

/**
 * The checkpoints a first attempt journaled, under the keys the shared stop sequence writes them with,
 * so `readStopCheckpoints` hands them back to the resumed stop.
 */
function stopJournalOn(
  envelope: Awaited<ReturnType<typeof startSimulatorRecording>>['envelope'],
  journal: JsonObject,
) {
  return { ...envelope, metadata: { ...(envelope.metadata ?? {}), ...journal } };
}

/** How the durable record hands a stop what its earlier attempt journaled. */
function stopProgressFor(envelope: ReturnType<typeof stopJournalOn>): DurableCaptureProgress {
  const learned = { ...(envelope.metadata ?? {}) };
  return Object.freeze({ learned, record: (fact: JsonObject) => Object.assign(learned, fact) });
}

test('a recovered export discloses the touch overlay whose events died with the daemon', async () => {
  const files = recordingFileStore();
  const started = await startSimulatorRecording(files, { showTouches: true });

  const reattached = await recoveryOperations(simulatorHost(files)).screenRecordingReattach({
    envelope: started.envelope,
  });
  if (reattached.status !== 'active') throw new Error('expected an exportable recording');
  const finished = await reattached.handle.finish();
  if (finished.status !== 'completed') throw new Error('expected a completed export');
  expect(finished.result.overlayWarning).toContain('overlay unavailable');
});

test('a simulator recording left by a manifest without export coordinates is still a loss', async () => {
  const files = recordingFileStore();
  const started = await startSimulatorRecording(files);
  const { recording: _dropped, ...bodyWithoutCoordinates } = started.envelope.descriptor.body;

  await expect(
    recoveryOperations(simulatorHost(files)).screenRecordingReattach({
      envelope: {
        ...started.envelope,
        descriptor: { ...started.envelope.descriptor, body: bodyWithoutCoordinates },
      },
    }),
  ).resolves.toEqual({ status: 'missing' });
});

test('a gone recorder with no readable video left behind is answered as a loss', async () => {
  const started = await startSimulatorRecording(recordingFileStore());

  await expect(
    recoveryOperations(simulatorHost(recordingFileStore())).screenRecordingReattach({
      envelope: started.envelope,
    }),
  ).resolves.toEqual({ status: 'missing' });
});

test('unreadable export coordinates refuse reattach before the recorder is probed', async () => {
  const files = recordingFileStore();
  const started = await startSimulatorRecording(files);
  const inspectProcess = vi.fn(async () => 'missing' as const);

  await expect(
    recoveryOperations(simulatorHost(files, { apple: { inspectProcess } })).screenRecordingReattach(
      {
        envelope: {
          ...started.envelope,
          descriptor: {
            ...started.envelope.descriptor,
            body: { ...started.envelope.descriptor.body, recording: { outPath: 42 } },
          },
        },
      },
    ),
  ).resolves.toMatchObject({ status: 'unreattachable', reason: 'descriptor-invalid' });
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
