import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { JsonObject } from '@agent-device/contracts/client';
import type { StopObservation } from '@agent-device/contracts/recording-stop-observation';
import { readStopCheckpoints, writeStopCheckpoint } from './stop-checkpoints.ts';

const FULL_FINALIZATION = Object.freeze({
  telemetryPath: '/tmp/recording.telemetry.json',
  warning: '2 chunks were merged',
  overlayWarning: 'overlay unavailable: session invalidated',
  nativePathDisposition: 'retired',
  chunks: [
    { index: 1, path: '/tmp/recording.mp4', clientOutPath: '/client/recording.mp4' },
    {
      index: 2,
      path: '/tmp/recording.part-002.mp4',
      clientOutPath: '/client/recording.part-002.mp4',
    },
  ],
  capturedDurationMs: 181_500,
} as const);

test('writes only the checkpoints a stop reached', () => {
  assert.deepEqual(
    writeStopCheckpoint({
      observation: { recorder: 'confirmed' },
      collectedPath: '/tmp/recording.collected.mp4',
    }),
    {
      stopObservation: { recorder: 'confirmed' },
      collectedPath: '/tmp/recording.collected.mp4',
    },
  );
});

test('writes nothing for a stop that proved nothing', () => {
  assert.deepEqual(writeStopCheckpoint({}), {});
});

test('reads back every checkpoint a stop wrote', () => {
  const fact = {
    observation: {
      recorder: 'unconfirmed',
      why: 'no-exit-in-budget',
    } satisfies StopObservation,
    stoppedAtMs: 1_700_000_000_000,
    recorderWarning: 'simctl exited with code 1 before record stop',
    collectedPath: '/tmp/recording.collected.mp4',
    exportPath: '/tmp/recording.mp4',
    finalization: FULL_FINALIZATION,
  };

  assert.deepEqual(readStopCheckpoints(writeStopCheckpoint(fact)), fact);
});

test('keeps the reason a recorder that was lost stopped', () => {
  const written = writeStopCheckpoint({
    observation: { recorder: 'lost', why: 'owner-session-lost' },
  });

  assert.deepEqual(written, { stopObservation: { recorder: 'lost', why: 'owner-session-lost' } });
  assert.deepEqual(readStopCheckpoints(written), {
    observation: { recorder: 'lost', why: 'owner-session-lost' },
  });
});

test('reads nothing from metadata no stop wrote', () => {
  assert.deepEqual(readStopCheckpoints(undefined), {});
  assert.deepEqual(readStopCheckpoints({ gestureEvents: [], outPath: '/tmp/recording.mp4' }), {});
});

test('keeps a checkpoint whose sibling is unreadable', () => {
  assert.deepEqual(
    readStopCheckpoints({
      stopObservation: { recorder: 'nonsense' },
      collectedPath: '/tmp/recording.collected.mp4',
      stopFinalization: 7,
    }),
    { collectedPath: '/tmp/recording.collected.mp4' },
  );
});

test('drops a finalization that names nothing the finalizer learned', () => {
  assert.deepEqual(readStopCheckpoints({ stopFinalization: {} }), {});
  assert.deepEqual(readStopCheckpoints({ stopFinalization: { telemetryPath: '' } }), {});
});

test('drops a finalization whose path disposition the contract does not declare', () => {
  assert.deepEqual(
    readStopCheckpoints({
      stopFinalization: {
        telemetryPath: '/tmp/recording.telemetry.json',
        nativePathDisposition: 'gone',
      },
    }),
    {},
  );
});

test('keeps a finalization that carries only the disposition of the recorder path', () => {
  assert.deepEqual(
    readStopCheckpoints({ stopFinalization: { nativePathDisposition: 'retirable' } }),
    {
      finalization: { nativePathDisposition: 'retirable' },
    },
  );
});

test('keeps the finalization fields that are readable and drops the ones that are not', () => {
  assert.deepEqual(
    readStopCheckpoints({
      stopFinalization: {
        telemetryPath: 42,
        warning: '2 chunks were merged',
        overlayWarning: {},
        nativePathDisposition: 'retired',
      },
    }),
    { finalization: { warning: '2 chunks were merged', nativePathDisposition: 'retired' } },
  );
});

test('refuses a finalization whose chunks or captured length it cannot read', () => {
  // Serving the export without its later chunks is the loss a replay must not cause, so a finalization
  // that cannot vouch for them is redone rather than served short.
  const damages: JsonObject[] = [
    { chunks: [{ index: 1 }] },
    { chunks: [{ index: 0, path: '/tmp/recording.mp4' }] },
    { chunks: 'two' },
    { capturedDurationMs: -1 },
    { capturedDurationMs: '181s' },
  ];
  for (const damaged of damages) {
    assert.deepEqual(
      readStopCheckpoints({
        stopFinalization: {
          warning: '2 chunks were merged',
          nativePathDisposition: 'retired',
          ...damaged,
        },
      }),
      {},
    );
  }
});

test('refuses an observation that is shaped like something else', () => {
  assert.deepEqual(readStopCheckpoints({ stopObservation: 'confirmed' }), {});
  assert.deepEqual(
    readStopCheckpoints({ stopObservation: { recorder: 'confirmed', why: 'oops' } }),
    {},
  );
});
