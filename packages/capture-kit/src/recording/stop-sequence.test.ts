import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { JsonObject } from '@agent-device/contracts/client';
import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import type { ScreenRecordingFinalization } from '@agent-device/contracts/recording-stop-progress';
import { type RecorderStop, stopAndExportScreenRecording } from './stop-sequence.ts';

test('signals the recorder, collects a sibling copy, and finalizes that copy into the export', async () => {
  const manifest = stopManifest();
  const steps = recordingSteps();

  const outcome = await stopAndExportScreenRecording({
    steps,
    snapshot: snapshot(),
    progress: manifest.progress,
    now: () => STOPPED_AT_MS,
  });

  assert.deepEqual(steps.collect.mock.calls, [['/tmp/recording.collected.mp4']]);
  assert.deepEqual(steps.finalize.mock.calls, [
    [
      {
        collectedPath: '/tmp/recording.collected.mp4',
        exportPath: '/tmp/recording.mp4',
        stoppedAtMs: STOPPED_AT_MS,
      },
    ],
  ]);
  assert.deepEqual(outcome.result.stopObservation, { recorder: 'confirmed' });
  assert.equal(outcome.result.nativePathDisposition, 'retired');
  assert.deepEqual(manifest.read(), {
    stopObservation: { recorder: 'confirmed' },
    stoppedAtMs: STOPPED_AT_MS,
    collectedPath: '/tmp/recording.collected.mp4',
    exportPath: '/tmp/recording.mp4',
    stopFinalization: {
      telemetryPath: '/tmp/recording.telemetry.json',
      warning: '2 chunks were merged',
      nativePathDisposition: 'retired',
    },
  });
});

test('discards the collected copy only once its finalization is journaled, on a replay too', async () => {
  const manifest = stopManifest();
  const journaledBeforeDiscard: (JsonObject | undefined)[] = [];
  const steps = recordingSteps();
  steps.discard.mockImplementation(async () => {
    journaledBeforeDiscard.push(manifest.read());
  });

  await stopAndExportScreenRecording({ steps, snapshot: snapshot(), progress: manifest.progress });
  const replay = recordingSteps();
  await stopAndExportScreenRecording({
    steps: replay,
    snapshot: snapshot(),
    progress: stopManifest(manifest.read()).progress,
  });

  assert.deepEqual(steps.discard.mock.calls, [['/tmp/recording.collected.mp4']]);
  assert.ok(
    journaledBeforeDiscard[0]?.stopFinalization,
    'discard ran before the finalization was journaled',
  );
  // A crash between the journal and the removal leaves the copy behind; the replay removes it.
  assert.deepEqual(replay.discard.mock.calls, [['/tmp/recording.collected.mp4']]);
});

test('discloses what the recorder did beside the export it produced', async () => {
  const steps = recordingSteps({
    stop: async () => ({
      observation: { recorder: 'confirmed' } as const,
      warning: 'recorder exited early',
    }),
  });

  const outcome = await stopAndExportScreenRecording({ steps, snapshot: snapshot() });

  assert.equal(outcome.result.warning, '2 chunks were merged recorder exited early');
});

test('asks the recorder again when the previous attempt signalled it and never confirmed it', async () => {
  const manifest = stopManifest({
    stopObservation: { recorder: 'unconfirmed', why: 'no-exit-in-budget' },
  });
  const steps = recordingSteps();

  const outcome = await stopAndExportScreenRecording({
    steps,
    snapshot: snapshot(),
    progress: manifest.progress,
  });

  assert.equal(steps.stop.mock.calls.length, 1);
  assert.deepEqual(outcome.result.stopObservation, { recorder: 'confirmed' });
  assert.deepEqual(manifest.read()?.stopObservation, { recorder: 'confirmed' });
});

test('does not signal a recorder the previous attempt confirmed', async () => {
  const manifest = stopManifest({ stopObservation: { recorder: 'confirmed' } });
  const steps = recordingSteps();

  await stopAndExportScreenRecording({ steps, snapshot: snapshot(), progress: manifest.progress });

  assert.equal(steps.stop.mock.calls.length, 0);
  assert.equal(steps.collect.mock.calls.length, 1);
});

test('never signals or retires the path of a recorder reported lost', async () => {
  const manifest = stopManifest({
    stopObservation: { recorder: 'lost', why: 'owner-session-lost' },
  });
  const steps = recordingSteps();

  const outcome = await stopAndExportScreenRecording({
    steps,
    snapshot: snapshot(),
    progress: manifest.progress,
  });

  assert.equal(steps.stop.mock.calls.length, 0);
  assert.deepEqual(outcome.result.stopObservation, { recorder: 'lost', why: 'owner-session-lost' });
});

test('resumes from the collected copy instead of collecting again', async () => {
  const manifest = stopManifest({
    stopObservation: { recorder: 'confirmed' },
    // The clock the earlier attempt read before it signalled: the resumed export measures that window,
    // not one that grows with the time between attempts.
    stoppedAtMs: STOPPED_AT_MS - 60_000,
    collectedPath: '/tmp/earlier.collected.mp4',
  });
  const steps = recordingSteps();

  await stopAndExportScreenRecording({
    steps,
    snapshot: snapshot(),
    progress: manifest.progress,
    now: () => STOPPED_AT_MS,
  });

  assert.deepEqual(steps.collect.mock.calls, []);
  assert.deepEqual(steps.finalize.mock.calls, [
    [
      {
        collectedPath: '/tmp/earlier.collected.mp4',
        exportPath: '/tmp/recording.mp4',
        stoppedAtMs: STOPPED_AT_MS - 60_000,
      },
    ],
  ]);
});

test('serves every field a journaled finalization carries, chunks and captured length included', async () => {
  const chunks = [
    { index: 1, path: '/tmp/recording.mp4' },
    { index: 2, path: '/tmp/recording.part-002.mp4' },
  ];
  const first = stopManifest();
  // The first attempt finalizes and journals; its commit is what fails, so the retry replays it.
  await stopAndExportScreenRecording({
    steps: recordingSteps({ finalization: { chunks, capturedDurationMs: 181_500 } }),
    snapshot: snapshot(),
    progress: first.progress,
    now: () => STOPPED_AT_MS,
  });
  const retry = recordingSteps();

  const outcome = await stopAndExportScreenRecording({
    steps: retry,
    snapshot: snapshot(),
    progress: stopManifest(first.read()).progress,
    now: () => STOPPED_AT_MS,
  });

  assert.deepEqual(retry.finalize.mock.calls, []);
  assert.deepEqual(outcome.result.chunks, chunks);
  assert.equal(outcome.result.capturedDurationMs, 181_500);
});

test('commits a journaled finalization without writing the export a second time', async () => {
  const manifest = stopManifest({
    stopObservation: { recorder: 'confirmed' },
    collectedPath: '/tmp/recording.collected.mp4',
    exportPath: '/tmp/recording.mp4',
    stopFinalization: {
      telemetryPath: '/tmp/recording.telemetry.json',
      warning: 'overlay skipped',
      nativePathDisposition: 'retirable',
    },
  });
  const steps = recordingSteps();

  const outcome = await stopAndExportScreenRecording({
    steps,
    snapshot: snapshot(),
    progress: manifest.progress,
  });

  assert.deepEqual(steps.finalize.mock.calls, []);
  assert.equal(outcome.result.telemetryPath, '/tmp/recording.telemetry.json');
  assert.equal(outcome.result.warning, 'overlay skipped');
  assert.equal(outcome.result.nativePathDisposition, 'retirable');
});

test('restarts a step whose checkpoint it cannot vouch for', async () => {
  const manifest = stopManifest({
    stopObservation: { recorder: 'confirmed', why: 'identity-not-ours' },
    collectedPath: 42,
    stopFinalization: { nativePathDisposition: 'gone-missing' },
  });
  const steps = recordingSteps();

  await stopAndExportScreenRecording({ steps, snapshot: snapshot(), progress: manifest.progress });

  assert.equal(steps.stop.mock.calls.length, 1);
  assert.equal(steps.collect.mock.calls.length, 1);
  assert.equal(steps.finalize.mock.calls.length, 1);
});

const STOPPED_AT_MS = 1_700_000_000_000;

function snapshot() {
  return {
    backend: 'fixture' as const,
    outPath: '/tmp/recording.mp4',
    startedAt: 1,
    scope: 'app' as const,
    showTouches: false,
    recordOnlySession: false,
    gestureEvents: [],
  };
}

function recordingSteps(
  overrides: {
    stop?: () => Promise<Readonly<{ observation: RecorderStop['observation']; warning?: string }>>;
    finalization?: Partial<ScreenRecordingFinalization>;
  } = {},
) {
  return {
    stop: vi.fn(
      overrides.stop ?? (async () => ({ observation: { recorder: 'confirmed' } as const })),
    ),
    collect: vi.fn(async (_collectedPath: string) => {}),
    discard: vi.fn(async (_collectedPath: string) => {}),
    finalize: vi.fn(async () => ({
      telemetryPath: '/tmp/recording.telemetry.json',
      warning: '2 chunks were merged',
      nativePathDisposition: 'retired' as const,
      ...overrides.finalization,
    })),
  };
}

function stopManifest(metadata?: JsonObject) {
  let stored: JsonObject | undefined = metadata;
  return {
    progress: Object.freeze({
      learned: metadata,
      record: (fact: JsonObject) => {
        stored = { ...(stored ?? {}), ...fact };
      },
    }) satisfies DurableCaptureProgress,
    read: () => stored,
  };
}
