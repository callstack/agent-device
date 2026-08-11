import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { makeRecordRuntimeHarness } from './record-runtime.fixtures.ts';

test('record start adopts the runtime pair and projects unchanged response metadata', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-', { appBundleId: 'com.example.app' });
  const outPath = path.join(mkdtempForTestSync('record-runtime-output-'), 'capture.mp4');

  const response = await harness.run(['start', outPath]);

  if (!response.ok) throw new Error(JSON.stringify(response.error));
  expect(response).toMatchObject({
    ok: true,
    data: {
      recording: 'started',
      outPath,
      recordingBackend: 'adb screenrecord',
      recordingScope: 'app',
      showTouches: true,
    },
  });
  expect(harness.runtime.start).toHaveBeenCalledOnce();
  expect(harness.sessionStore.get(harness.sessionName)?.screenRecording?.handle).toBe(
    harness.runtime.handle,
  );
});

test('record start preserves the requested path while the runtime receives the expanded native path', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-relative-output-');
  const cwd = mkdtempForTestSync('record-runtime-relative-output-cwd-');

  const response = await harness.run(['start', 'capture.mp4'], { cwd });

  expect(response).toMatchObject({ ok: true, data: { outPath: 'capture.mp4' } });
  expect(harness.runtime.start).toHaveBeenCalledWith(
    expect.objectContaining({ outputPath: path.join(cwd, 'capture.mp4') }),
  );
});

test.each(['linux', 'vega'] as const)(
  'record start on %s reports public unsupported guidance',
  async (platform) => {
    const harness = makeRecordRuntimeHarness(`record-runtime-${platform}-unsupported-`, {
      platform,
      runtime: {
        screenRecordingStartFact: {
          available: false,
          reason: 'unsupported-platform-leaf',
        },
      },
    });

    const response = await harness.run(['start', 'capture.mp4']);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'record is not supported on this device',
        hint: 'Select an Apple, Android, physical HarmonyOS, or web target that supports screen recording.',
        details: { reason: 'unsupported-platform-leaf' },
      },
    });
    expect(harness.runtime.start).not.toHaveBeenCalled();
  },
);
