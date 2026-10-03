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
      {
        stopObservation: { recorder: 'unconfirmed', why: 'no-exit-in-budget' },
        showTouches: false,
      },
    ),
  ).toEqual({
    status: 'completed',
    result: {
      backend: 'backend',
      outPath: '/tmp/capture.mp4',
      clientOutPath: '/client/capture.mp4',
      startedAt: 100,
      completedAt: 200,
      stopObservation: { recorder: 'unconfirmed', why: 'no-exit-in-budget' },
      scope: 'device',
      showTouches: false,
      recordOnlySession: false,
      telemetryPath: '/tmp/capture.telemetry.json',
    },
  });
  vi.useRealTimers();
});

test('records a native-path disposition only when the backend states one', () => {
  const snapshot = {
    backend: 'backend',
    outPath: '/tmp/capture.mp4',
    startedAt: 100,
    scope: 'device' as const,
    showTouches: false,
    recordOnlySession: false,
    gestureEvents: [],
  };
  expect(
    createScreenRecordingCompletion(snapshot, {}, { stopObservation: { recorder: 'confirmed' } })
      .result,
  ).not.toHaveProperty('nativePathDisposition');
  expect(
    createScreenRecordingCompletion(
      snapshot,
      {},
      {
        stopObservation: { recorder: 'confirmed' },
        nativePathDisposition: 'retirable',
      },
    ).result,
  ).toMatchObject({ nativePathDisposition: 'retirable' });
});
