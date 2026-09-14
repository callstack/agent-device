import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { JsonObject } from '@agent-device/contracts/client';
import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import {
  type RecorderStop,
  stopAndExportScreenRecording,
} from './screen-recording-stop-sequence.ts';

test('signals the recorder, collects a sibling copy, and finalizes that copy into the export', async () => {
  const manifest = stopManifest();
  const steps = recordingSteps();

  const outcome = await stopAndExportScreenRecording({
    steps,
    snapshot: snapshot(),
    progress: manifest.progress,
  });

  assert.deepEqual(steps.collect.mock.calls, [['/tmp/recording.collected.mp4']]);
  assert.deepEqual(steps.finalize.mock.calls, [
    [{ collectedPath: '/tmp/recording.collected.mp4', exportPath: '/tmp/recording.mp4' }],
  ]);
  assert.deepEqual(outcome.result.stopObservation, { recorder: 'confirmed' });
  assert.equal(outcome.result.nativePathDisposition, 'retired');
  assert.deepEqual(manifest.read(), {
    stopObservation: { recorder: 'confirmed' },
    collectedPath: '/tmp/recording.collected.mp4',
    exportPath: '/tmp/recording.mp4',
    stopFinalization: {
      telemetryPath: '/tmp/recording.telemetry.json',
      warning: '2 chunks were merged',
      nativePathDisposition: 'retired',
    },
  });
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
    collectedPath: '/tmp/earlier.collected.mp4',
  });
  const steps = recordingSteps();

  await stopAndExportScreenRecording({ steps, snapshot: snapshot(), progress: manifest.progress });

  assert.deepEqual(steps.collect.mock.calls, []);
  assert.deepEqual(steps.finalize.mock.calls, [
    [{ collectedPath: '/tmp/earlier.collected.mp4', exportPath: '/tmp/recording.mp4' }],
  ]);
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
  } = {},
) {
  return {
    stop: vi.fn(
      overrides.stop ?? (async () => ({ observation: { recorder: 'confirmed' } as const })),
    ),
    collect: vi.fn(async (_collectedPath: string) => {}),
    finalize: vi.fn(async () => ({
      telemetryPath: '/tmp/recording.telemetry.json',
      warning: '2 chunks were merged',
      nativePathDisposition: 'retired' as const,
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
