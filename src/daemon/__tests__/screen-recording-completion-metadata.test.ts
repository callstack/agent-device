import { expect, test } from 'vitest';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { decodeScreenRecordingCompletionMetadata } from '../screen-recording-completion-metadata.ts';
import { encodeScreenRecordingCompletionMetadata } from '../screen-recording-session-resource.ts';

const MINIMAL_COMPLETION: ScreenRecordingCompletion = {
  backend: 'simctl',
  outPath: '/daemon/state/sessions/recording/capture.mp4',
  startedAt: 10,
  completedAt: 40,
  scope: 'app',
  showTouches: true,
  recordOnlySession: false,
};

const FULL_COMPLETION: ScreenRecordingCompletion = {
  ...MINIMAL_COMPLETION,
  clientOutPath: '/workspace/artifacts/capture.mp4',
  activeSessionApp: { bundleId: 'dev.example.app', name: 'Example' },
  telemetryPath: '/daemon/state/sessions/recording/capture.gesture-telemetry.json',
  warning: 'recording was truncated at the platform limit',
  overlayWarning: 'touch overlay burn-in is only available on macOS hosts',
  chunks: [
    { index: 0, path: '/daemon/state/a-0.mp4', clientOutPath: '/workspace/a-0.mp4' },
    { index: 1, path: '/daemon/state/a-1.mp4' },
  ],
};

test('a manifest written by the resource definition reads back as the same stop response', () => {
  expect(decode(FULL_COMPLETION)).toEqual(FULL_COMPLETION);
});

test('completion metadata round-trips a completion without optional fields', () => {
  expect(decode(MINIMAL_COMPLETION)).toEqual(MINIMAL_COMPLETION);
});

test('completion metadata without a completion is not replayable', () => {
  expect(decodeScreenRecordingCompletionMetadata({ phase: 'completed' })).toMatchObject({
    status: 'invalid',
  });
  expect(decodeScreenRecordingCompletionMetadata(undefined)).toMatchObject({
    status: 'invalid',
  });
});

test('completion metadata with a damaged completion is not replayable', () => {
  const encoded = encodeScreenRecordingCompletionMetadata(FULL_COMPLETION);
  expect(decodeScreenRecordingCompletionMetadata({ ...encoded, outputPath: 0 })).toMatchObject({
    status: 'invalid',
  });
  expect(
    decodeScreenRecordingCompletionMetadata({ ...encoded, scope: 'whole-screen' }),
  ).toMatchObject({ status: 'invalid' });
  expect(decodeScreenRecordingCompletionMetadata({ ...encoded, clientOutPath: '' })).toMatchObject({
    status: 'invalid',
  });
  expect(
    decodeScreenRecordingCompletionMetadata({
      ...encoded,
      chunks: [{ index: 'first', path: '/daemon/state/a-0.mp4' }],
    }),
  ).toMatchObject({ status: 'invalid' });
});

function decode(completion: ScreenRecordingCompletion) {
  const decoded = decodeScreenRecordingCompletionMetadata(
    encodeScreenRecordingCompletionMetadata(completion),
  );
  if (decoded.status !== 'decoded') {
    throw new Error(`Expected decoded completion: ${decoded.reason}`);
  }
  return decoded.completion;
}
