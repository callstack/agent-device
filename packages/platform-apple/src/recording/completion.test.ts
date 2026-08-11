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
    completeAppleRecording(appleRecordingHost(), snapshot, 'iOS recording'),
  ).resolves.toMatchObject({
    status: 'completed',
    result: { overlayWarning: 'overlay unavailable: runner restarted' },
  });
});
