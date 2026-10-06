import { expect, test } from 'vitest';
import { completeAppleRecording, finalizeAppleRecordingFromCollected } from './completion.ts';
import { recordingFileStore } from '@agent-device/capture-kit/recording-artifact-fixtures';
import { appleRecordingHost } from './runtime.fixtures.ts';

test('projects invalidated touch-overlay state without publishing a false overlay', async () => {
  const snapshot = {
    backend: 'runner AVAssetWriter',
    outPath: '/tmp/capture.mp4',
    startedAt: 1,
    scope: 'app' as const,
    showTouches: true,
    recordOnlySession: false,
    gestureEvents: [],
    invalidatedReason: 'runner restarted',
  };
  await expect(
    completeAppleRecording({
      host: appleRecordingHost(),
      snapshot,
      targetLabel: 'iOS recording',
      stopObservation: { recorder: 'confirmed' },
    }),
  ).resolves.toMatchObject({
    status: 'completed',
    result: {
      overlayWarning: 'overlay unavailable: runner restarted',
      stopObservation: { recorder: 'lost', why: 'owner-session-lost' },
    },
  });
});

test('hands the caller fps to the finalizer that burns the touch overlay', async () => {
  const requests: Readonly<{ showTouches: boolean; fps?: number }>[] = [];
  await completeAppleRecording({
    host: appleRecordingHost({
      complete: async (input) => {
        requests.push(input);
        return {};
      },
    }),
    snapshot: {
      backend: 'simctl',
      outPath: '/tmp/capture.mp4',
      startedAt: 1,
      scope: 'app',
      showTouches: true,
      recordOnlySession: false,
      fps: 15,
      gestureEvents: [],
    },
    targetLabel: 'iOS recording',
    stopObservation: { recorder: 'confirmed' },
  });

  expect(requests).toEqual([expect.objectContaining({ showTouches: true, fps: 15 })]);
});

test('hands the finalizer no fps when the caller asked for none', async () => {
  const requests: Readonly<{ fps?: number }>[] = [];
  await completeAppleRecording({
    host: appleRecordingHost({
      complete: async (input) => {
        requests.push(input);
        return {};
      },
    }),
    snapshot: {
      backend: 'simctl',
      outPath: '/tmp/capture.mp4',
      startedAt: 1,
      scope: 'app',
      showTouches: true,
      recordOnlySession: false,
      gestureEvents: [],
    },
    targetLabel: 'iOS recording',
    stopObservation: { recorder: 'confirmed' },
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toHaveProperty('fps');
});

test('a collected simulator copy hands the caller fps to the finalizer, and none when unset', async () => {
  for (const fps of [10, undefined]) {
    const requests: Readonly<{ fps?: number }>[] = [];
    const files = recordingFileStore();
    files.files.set('/tmp/capture.collected.mp4', 'fake-video');
    await finalizeAppleRecordingFromCollected({
      host: appleRecordingHost({
        files,
        complete: async (input) => {
          requests.push(input);
          return {};
        },
      }),
      snapshot: {
        backend: 'simctl',
        outPath: '/tmp/capture.mp4',
        startedAt: 1,
        scope: 'app',
        showTouches: true,
        recordOnlySession: false,
        ...(fps === undefined ? {} : { fps }),
        gestureEvents: [],
      },
      targetLabel: 'iOS recording',
      collectedPath: '/tmp/capture.collected.mp4',
      exportPath: '/tmp/capture.mp4',
      nativePath: '/tmp/capture.native.mp4',
    });

    expect(requests).toHaveLength(1);
    if (fps === undefined) expect(requests[0]).not.toHaveProperty('fps');
    else expect(requests[0]).toMatchObject({ showTouches: true, fps });
  }
});
