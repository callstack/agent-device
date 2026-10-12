import { test } from 'vitest';
import assert from 'node:assert/strict';
import { withInteractiveStderr } from '../../__tests__/test-utils/stream-capture.ts';
import {
  createStderrUploadProgressReporter,
  type UploadProgressEvent,
} from '../upload-progress.ts';

function renderEvents(events: UploadProgressEvent[]): string {
  return withInteractiveStderr(() => {
    const sink = createStderrUploadProgressReporter();
    assert.equal(sink !== undefined, true);
    for (const event of events) sink!(event);
  });
}

test('the stderr reporter formats start, resume, progress and fallback events', () => {
  const output = renderEvents([
    {
      type: 'start',
      stage: 'direct',
      fileName: 'app.apk',
      transferredBytes: 0,
      totalBytes: 5 * 1024 * 1024,
    },
    {
      type: 'resume',
      stage: 'legacy',
      fileName: 'app.apk',
      transferredBytes: 2 * 1024 * 1024,
      totalBytes: 5 * 1024 * 1024,
    },
    {
      type: 'progress',
      stage: 'direct',
      fileName: 'app.apk',
      transferredBytes: 5 * 1024 * 1024,
      totalBytes: 5 * 1024 * 1024,
    },
    {
      type: 'fallback',
      from: 'direct',
      to: 'legacy',
      fileName: 'app.apk',
    },
  ]);
  const lines = output.split('\n').filter(Boolean);
  assert.deepEqual(lines, [
    'Uploading app.apk (5.0 MiB) via direct upload',
    'Resuming app.apk at 2.0 MiB of 5.0 MiB',
    'Uploaded 5.0 MiB of 5.0 MiB (100%)',
    'Direct upload did not complete; retrying app.apk with legacy upload',
  ]);
});

test('the stderr reporter formats byte magnitudes and clamps progress percentages', () => {
  const output = renderEvents([
    {
      type: 'progress',
      stage: 'legacy',
      fileName: 'clip.mp4',
      transferredBytes: 900,
      totalBytes: 4 * 1024,
    },
    {
      type: 'progress',
      stage: 'legacy',
      fileName: 'clip.mp4',
      transferredBytes: 3 * 1024 * 1024,
      totalBytes: 2 * 1024 * 1024,
    },
    {
      type: 'progress',
      stage: 'legacy',
      fileName: 'clip.mp4',
      transferredBytes: 2 * 1024 * 1024 * 1024,
      totalBytes: 2 * 1024 * 1024 * 1024,
    },
    {
      type: 'progress',
      stage: 'legacy',
      fileName: 'clip.mp4',
      transferredBytes: 0,
      totalBytes: 0,
    },
  ]);
  const lines = output.split('\n').filter(Boolean);
  assert.deepEqual(lines, [
    'Uploaded 900 B of 4.0 KiB (21%)',
    'Uploaded 3.0 MiB of 2.0 MiB (100%)',
    'Uploaded 2.0 GiB of 2.0 GiB (100%)',
    'Uploaded 0 B of 0 B (100%)',
  ]);
});
