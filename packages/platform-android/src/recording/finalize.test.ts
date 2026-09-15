import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import type { JsonObject } from '@agent-device/contracts/client';
import { mp4Atom, mp4MovieHeader } from '@agent-device/capture-kit/recording-mp4-fixtures';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';
import { finalizeAndroidRecording } from './finalize.ts';
import { recordingFileStore } from '@agent-device/capture-kit/recording-artifact-fixtures';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
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

test('a chunked export the finalizer refuses leaves the caller paths empty and the pulled set for the retry', async () => {
  const files = recordingFileStore();
  const host = recordingHost({
    files,
    finalize: {
      complete: async () => {
        throw new Error('recording was not finalized into a playable video');
      },
    },
  });
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);

  await expect(
    finalizeAndroidRecording({
      host,
      transport,
      evidence: evidenceFor([REMOTE_CHUNK, '/sdcard/agent-device-recording-2.mp4']),
      manifestPath: '/sdcard/agent-device-recording-active.json',
      recording: snapshot(recordingInput(), 1),
      startedAtMs: 1,
    }),
  ).rejects.toThrow('playable video');

  expect(files.exists('/tmp/capture.mp4')).toBe(false);
  expect(files.exists('/tmp/capture.part-002.mp4')).toBe(false);
  expect(files.exists('/tmp/capture.collected.mp4')).toBe(true);
  expect(files.exists('/tmp/capture.collected.part-002.mp4')).toBe(true);
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

test('a retried commit serves every chunk and the captured length its first attempt finalized', async () => {
  const directory = mkdtempForTestSync('agent-device-android-retry-');
  const files = recordingFileStore();
  let completedWrites = 0;
  const host = recordingHost({
    files,
    isRunning: async () => false,
    pullPlayable: async ({ outputPath }: { outputPath: string }) => {
      fs.writeFileSync(outputPath, playableMp4(90_000));
      files.files.set(outputPath, 'pulled');
      return { stdout: '', stderr: '', exitCode: 0, playable: true };
    },
    writeManifest: async ({ contents }: { contents: string }) => {
      // The export is finalized and journaled; the device refuses the completion marker once, which
      // is the commit failure a retried `record stop` has to replay rather than redo.
      if (JSON.parse(contents).completion && ++completedWrites === 1) {
        throw new Error('adb: device offline');
      }
    },
  });
  const input = { ...recordingInput(), outputPath: path.join(directory, 'capture.mp4') };
  const evidence = evidenceFor([REMOTE_CHUNK, '/sdcard/agent-device-recording-2.mp4']);
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
  const manifest = journal();
  const stop = () =>
    finalizeAndroidRecording({
      host,
      transport,
      evidence,
      manifestPath: '/sdcard/agent-device-recording-active.json',
      recording: snapshot(input, 1),
      startedAtMs: Date.now() - 181_000,
      progress: manifest.progress(),
    });

  await expect(stop()).rejects.toThrow('device offline');
  const outcome = await stop();

  expect(outcome.status).toBe('completed');
  if (outcome.status !== 'completed') return;
  expect(outcome.result.chunks).toEqual([
    { index: 1, path: path.join(directory, 'capture.mp4') },
    { index: 2, path: path.join(directory, 'capture.part-002.mp4') },
  ]);
  expect(outcome.result.capturedDurationMs).toBe(180_000);
});

test('a stop resumed after its collect measures the window its first attempt signalled', async () => {
  const directory = mkdtempForTestSync('agent-device-android-resume-');
  const collectedPath = path.join(directory, 'capture.collected.mp4');
  fs.writeFileSync(collectedPath, playableMp4(7_000));
  const files = recordingFileStore({ [collectedPath]: 'pulled' });
  const host = recordingHost({ files });
  const input = { ...recordingInput(), outputPath: path.join(directory, 'capture.mp4') };
  const startedAtMs = Date.now() - 120_000;
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);

  const outcome = await finalizeAndroidRecording({
    host,
    transport,
    evidence: evidenceFor([REMOTE_CHUNK]),
    manifestPath: '/sdcard/agent-device-recording-active.json',
    recording: snapshot(input, 1),
    startedAtMs,
    // Signalled 7.5 s in, then the first attempt failed and this one runs almost two minutes later.
    progress: completedProgress({
      stopObservation: { recorder: 'confirmed' },
      stoppedAtMs: startedAtMs + 7_500,
      collectedPath,
    }),
  });

  expect(outcome.status).toBe('completed');
  if (outcome.status !== 'completed') return;
  expect(outcome.result.capturedDurationMs).toBe(7_000);
  expect(outcome.result.warning).toBeUndefined();
});

function playableMp4(durationMs: number): Buffer {
  return Buffer.concat([
    mp4Atom('mdat', Buffer.alloc(8)),
    mp4Atom(
      'moov',
      mp4Atom('mvhd', mp4MovieHeader({ version: 0, timescale: 1_000, duration: durationMs })),
    ),
  ]);
}

function journal() {
  let stored: JsonObject | undefined;
  return {
    progress: (): DurableCaptureProgress => ({
      learned: stored,
      record: (fact) => {
        stored = { ...(stored ?? {}), ...fact };
      },
    }),
  };
}
