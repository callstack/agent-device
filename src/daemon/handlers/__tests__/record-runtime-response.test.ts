import path from 'node:path';
import { expect, test } from 'vitest';
import {
  buildRecordingStartResponse,
  buildRecordingStopResponse,
} from '../record-runtime-response.ts';

test('start response preserves client output and neutral recording metadata', () => {
  expect(
    buildRecordingStartResponse(
      {
        backend: 'adb screenrecord',
        outPath: '/daemon/capture.mp4',
        clientOutPath: '/client/capture.mp4',
        startedAt: 10,
        scope: 'app',
        showTouches: true,
        recordOnlySession: false,
        gestureEvents: [],
      },
      '/state/session',
      '/requested/capture.mp4',
    ),
  ).toMatchObject({
    ok: true,
    data: {
      recording: 'started',
      outPath: '/client/capture.mp4',
      sessionStateDir: '/state/session',
      recordingBackend: 'adb screenrecord',
    },
  });
});

test('stop response derives client telemetry and chunk artifact paths', () => {
  const response = buildRecordingStopResponse({
    backend: 'adb screenrecord',
    outPath: '/daemon/capture.mp4',
    clientOutPath: '/client/capture.mp4',
    startedAt: 10,
    completedAt: 25,
    scope: 'app',
    showTouches: true,
    recordOnlySession: false,
    telemetryPath: '/daemon/capture.gesture-telemetry.json',
    chunks: [
      { index: 0, path: '/daemon/capture.mp4', clientOutPath: '/client/capture.mp4' },
      { index: 1, path: '/daemon/capture-1.mp4', clientOutPath: '/client/capture-1.mp4' },
    ],
  });

  if (!response.ok) throw new Error(JSON.stringify(response.error));
  expect(response.data?.artifacts).toContainEqual(
    expect.objectContaining({
      field: 'telemetryPath',
      path: '/daemon/capture.gesture-telemetry.json',
      localPath: path.join('/client', 'capture.gesture-telemetry.json'),
    }),
  );
  expect(response.data?.artifacts).toContainEqual(
    expect.objectContaining({
      field: 'chunkPath',
      path: '/daemon/capture-1.mp4',
      localPath: '/client/capture-1.mp4',
    }),
  );
});
