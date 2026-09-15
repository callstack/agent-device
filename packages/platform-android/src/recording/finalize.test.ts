import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import type { JsonObject } from '@agent-device/contracts/client';
import { mp4Atom, mp4MovieHeader } from '@agent-device/capture-kit/recording-mp4-fixtures';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';
import { finalizeAndroidRecording } from './finalize.ts';
import {
  androidRecordingDevice,
  recordingFileStore,
  recordingHost,
  recordingInput,
} from './fixtures.ts';
import { createNativeManifest, type NativeManifest } from './manifest.ts';
import { snapshot } from './live-snapshot.ts';

const REMOTE_CHUNK = '/sdcard/agent-device-recording-1.mp4';

function evidenceFor(chunks: readonly string[]): NativeManifest {
  return createNativeManifest(
    androidRecordingDevice,
    recordingInput(),
    1,
    chunks.map((remotePath, offset) => ({
      index: offset + 1,
      remotePath,
      remotePid: String(41 + offset),
      remoteStartTime: '7',
    })),
    undefined,
    'local',
  );
}

function completedProgress(learned: JsonObject): DurableCaptureProgress {
  return {
    learned,
    record: () => {},
  };
}

test('writes terminal coordinates before removing a fenced Android artifact', async () => {
  const calls: string[] = [];
  const host = recordingHost({
    writeManifest: async ({ contents }: { contents: string }) => {
      calls.push(JSON.parse(contents).completion ? 'completed' : 'active');
    },
    remove: async (remotePath: string) => {
      calls.push(`remove:${remotePath}`);
      return true;
    },
  });
  const input = recordingInput();
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
  await expect(
    finalizeAndroidRecording({
      host,
      transport,
      evidence: evidenceFor([REMOTE_CHUNK]),
      manifestPath: '/sdcard/agent-device-recording-active.json',
      recording: snapshot(input, 1),
      startedAtMs: 1,
    }),
  ).resolves.toMatchObject({ status: 'completed' });
  expect(calls).toEqual(['completed', `remove:${REMOTE_CHUNK}`]);
});

test('serves the export from a copy of the collected chunk and retires the copy', async () => {
  const files = recordingFileStore();
  const host = recordingHost({
    files,
    finalize: {
      complete: async ({ outputPath }: { outputPath: string }) => {
        expect(files.exists(outputPath)).toBe(true);
        return {};
      },
    },
  });
  const input = recordingInput();
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);

  await expect(
    finalizeAndroidRecording({
      host,
      transport,
      evidence: evidenceFor([REMOTE_CHUNK]),
      manifestPath: '/sdcard/agent-device-recording-active.json',
      recording: snapshot(input, 1),
      startedAtMs: 1,
    }),
  ).resolves.toMatchObject({ status: 'completed' });

  expect(files.exists('/tmp/capture.mp4')).toBe(true);
  expect(files.exists('/tmp/capture.collected.mp4')).toBe(false);
});

test('a stop that already collected serves the export without signalling again', async () => {
  const calls: string[] = [];
  const files = recordingFileStore({ '/tmp/capture.collected.mp4': 'recorded' });
  const host = recordingHost({
    files,
    stop: async () => {
      calls.push('stop');
      return 'stopped' as const;
    },
    pullPlayable: async ({ outputPath }: { outputPath: string }) => {
      calls.push(`pull:${outputPath}`);
      files.files.set(outputPath, 'recorded');
      return { stdout: '', stderr: '', exitCode: 0, playable: true };
    },
  });
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);

  const outcome = await finalizeAndroidRecording({
    host,
    transport,
    evidence: evidenceFor([REMOTE_CHUNK]),
    manifestPath: '/sdcard/agent-device-recording-active.json',
    recording: snapshot(recordingInput(), 1),
    startedAtMs: 1,
    progress: completedProgress({
      stopObservation: { recorder: 'confirmed' },
      collectedPath: '/tmp/capture.collected.mp4',
    }),
  });

  expect(calls).toEqual([]);
  expect(outcome.status).toBe('completed');
  if (outcome.status !== 'completed') return;
  expect(outcome.result.stopObservation).toEqual({ recorder: 'confirmed' });
  expect(files.exists('/tmp/capture.mp4')).toBe(true);
});

test('answers with the disposition the device shows after disposal', async () => {
  const host = recordingHost({
    // The device agrees to every removal and then keeps listing the file, which is the case the
    // disposition exists for: the caller is told the chunks are still owed a removal.
    exists: async () => true,
  });
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);

  const outcome = await finalizeAndroidRecording({
    host,
    transport,
    evidence: evidenceFor([REMOTE_CHUNK]),
    manifestPath: '/sdcard/agent-device-recording-active.json',
    recording: snapshot(recordingInput(), 1),
    startedAtMs: 1,
  });

  expect(outcome.status).toBe('completed');
  if (outcome.status !== 'completed') return;
  expect(outcome.result.stopObservation).toEqual({ recorder: 'confirmed' });
  expect(outcome.result.nativePathDisposition).toBe('retirable');
});

test('discloses the finalizer, the platform limit, and the split in one answer', async () => {
  const host = recordingHost({
    finalize: {
      complete: async () => ({ warning: 'recording was exported without touch overlays' }),
    },
  });
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);

  const outcome = await finalizeAndroidRecording({
    host,
    transport,
    evidence: evidenceFor([REMOTE_CHUNK, '/sdcard/agent-device-recording-2.mp4']),
    manifestPath: '/sdcard/agent-device-recording-active.json',
    recording: snapshot({ ...recordingInput(), showTouches: false }, 1),
    startedAtMs: 1,
    reachedLimit: true,
  });

  expect(outcome.status).toBe('completed');
  if (outcome.status !== 'completed') return;
  const warning = outcome.result.warning ?? '';
  expect(warning).toMatch(
    /^recording was exported without touch overlays Android adb screenrecord is capped at 180s/,
  );
  expect(warning).toContain('Android adb screenrecord stopped before record stop');
  expect(outcome.result.chunks).toEqual([
    { index: 1, path: '/tmp/capture.mp4' },
    { index: 2, path: '/tmp/capture.part-002.mp4' },
  ]);
});

test('measures a pulled MP4 against the window the host bracketed around the recorder', async () => {
  const directory = mkdtempForTestSync('agent-device-android-finalize-');
  const calls: string[] = [];
  const host = recordingHost({
    stop: async () => {
      calls.push('stop');
      return 'stopped' as const;
    },
    isRunning: async () => false,
    pullPlayable: async ({ outputPath }: { outputPath: string }) => {
      calls.push('pull');
      fs.writeFileSync(
        outputPath,
        Buffer.concat([
          mp4Atom('mdat', Buffer.alloc(8)),
          mp4Atom(
            'moov',
            mp4Atom('mvhd', mp4MovieHeader({ version: 0, timescale: 1_000, duration: 7_000 })),
          ),
        ]),
      );
      return { stdout: '', stderr: '', exitCode: 0, playable: true };
    },
  });
  const input = { ...recordingInput(), outputPath: path.join(directory, 'capture.mp4') };
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
  const outcome = await finalizeAndroidRecording({
    host,
    transport,
    evidence: evidenceFor([REMOTE_CHUNK]),
    manifestPath: '/sdcard/agent-device-recording-active.json',
    recording: snapshot(input, 1),
    startedAtMs: Date.now() - 16_000,
  });

  expect(calls).toEqual(['stop', 'pull']);
  expect(outcome.status).toBe('completed');
  if (outcome.status !== 'completed') return;
  expect(outcome.result.capturedDurationMs).toBe(7_000);
  expect(outcome.result.outPath).toBe(path.join(directory, 'capture.mp4'));
  expect(outcome.result.warning).toMatch(/it covers 7\.0s of the 16\.\ds recording window\./);
});
