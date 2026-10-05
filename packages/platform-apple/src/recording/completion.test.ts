import { expect, test } from 'vitest';
import { completeAppleRecording } from './completion.ts';
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
