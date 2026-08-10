import { expect, test, vi } from 'vitest';
import { createScreenRecordingCompletion } from './screen-recording-completion.ts';

test('builds the common terminal recording result without dropping finalizer metadata', () => {
  vi.setSystemTime(200);
  expect(
    createScreenRecordingCompletion(
      {
        backend: 'backend',
        outPath: '/tmp/capture.mp4',
        clientOutPath: '/client/capture.mp4',
        startedAt: 100,
        scope: 'device',
        showTouches: true,
        recordOnlySession: false,
        gestureEvents: [],
      },
      { telemetryPath: '/tmp/capture.telemetry.json' },
      false,
    ),
  ).toEqual({
    status: 'completed',
    result: {
      backend: 'backend',
      outPath: '/tmp/capture.mp4',
      clientOutPath: '/client/capture.mp4',
      startedAt: 100,
      completedAt: 200,
      scope: 'device',
      showTouches: false,
      recordOnlySession: false,
      telemetryPath: '/tmp/capture.telemetry.json',
    },
  });
  vi.useRealTimers();
});
