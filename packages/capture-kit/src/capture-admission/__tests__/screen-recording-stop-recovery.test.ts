import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { JsonObject } from '@agent-device/contracts/client';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope } from '../../durable-resource-envelope.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceIdentity } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';
import {
  screenRecordingPendingCompletionBinding,
  screenRecordingResourceStore,
} from '../screen-recording-resource-store.ts';
import { encodeScreenRecordingCompletionMetadata } from '../screen-recording-session-resource.ts';
import {
  resolveScreenRecordingStopRecovery,
  screenRecordingManifestIsTerminal,
} from '../screen-recording-stop-recovery.ts';
import type { DurableCaptureSessionState } from '../session-state-slice.ts';
import {
  makeCaptureAdmissionSessionStore,
  type CaptureAdmissionSessionStore,
} from './session-store.fixtures.ts';

const SESSION_NAME = 'recording';
const SESSION_DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
};

test('a completed manifest with no surviving video serves nothing', async () => {
  const harness = makeHarness();
  await completeRecording(harness);
  fs.rmSync(harness.videoPath);

  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    { kind: 'none' },
  );
});

test('a completed manifest hands back the whole stop response it stored', async () => {
  const harness = makeHarness();
  const completion = fullCompletion(harness.videoPath);
  writeCompletionVideos(completion);
  writeManifest(harness, encodeScreenRecordingCompletionMetadata(completion));

  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    { kind: 'completed', completion },
  );
  expect(screenRecordingManifestIsTerminal(harness.params)).toBe(true);
});

test('a completed manifest whose stored response is damaged serves nothing', async () => {
  const harness = makeHarness();
  const completion = fullCompletion(harness.videoPath);
  const stored = encodeScreenRecordingCompletionMetadata(completion);
  writeCompletionVideos(completion);

  const damages: JsonObject[] = [
    { outPath: 0 },
    { clientOutPath: '' },
    { completedAt: 'later' },
    { capturedDurationMs: 'soon' },
    { chunks: [{ index: 'first', path: '/daemon/capture-0.mp4' }] },
    { activeSessionApp: { bundleId: '' } },
    { stopObservation: { recorder: 'confirmed', why: 'identity-unreadable' } },
    { stopObservation: 'confirmed' },
    { nativePathDisposition: 'deleted' },
  ];

  for (const damaged of damages) {
    writeManifest(harness, withStoredCompletion(stored, damaged));
    expect(
      resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE }),
    ).toEqual({ kind: 'none' });
  }
});

test('a completed manifest with no completion metadata serves nothing', async () => {
  const harness = makeHarness();
  await completeRecording(harness);
  writeManifest(harness, { phase: 'completed' });

  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    { kind: 'none' },
  );
});

test('a completed manifest owned by another session is refused', async () => {
  const harness = makeHarness();
  await completeRecording(harness);
  writeManifest(harness, undefined, { sessionId: 'other-session' });

  expect(() =>
    resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE }),
  ).toThrowError(expect.objectContaining({ details: { reason: 'runtime-contract-invalid' } }));
});

test('a completed manifest bound to another device is refused', async () => {
  const harness = makeHarness();
  await completeRecording(harness);
  writeManifest(harness, undefined, {
    device: deviceIdentity({ ...SESSION_DEVICE, id: 'emulator-5556' }),
  });

  expect(() =>
    resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE }),
  ).toThrowError(expect.objectContaining({ details: { reason: 'runtime-contract-invalid' } }));
});

test('an open manifest stays available for exact-owner recovery', async () => {
  const harness = makeHarness();
  writeManifest(harness, { phase: 'active' }, { lifecycle: 'open' });

  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    { kind: 'open', resourcePath: manifestPath(harness.sessionStore) },
  );
  expect(screenRecordingManifestIsTerminal(harness.params)).toBe(false);
});

test('an open cleanup obligation exposes its surviving export without becoming terminal', () => {
  const harness = makeHarness();
  const completion = fullCompletion(harness.videoPath);
  writeCompletionVideos(completion);
  const metadata = {
    ...encodeScreenRecordingCompletionMetadata(completion),
    phase: 'cleanup-pending',
    cleanupStatus: 'cleanup-pending',
    deviceClaimToken: 'claim',
  };
  writeManifest(harness, metadata, { lifecycle: 'open' });
  const resourcePath = manifestPath(harness.sessionStore);
  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    {
      kind: 'open',
      resourcePath,
    },
  );
  const record = screenRecordingResourceStore.read(resourcePath);
  if (record.status !== 'decoded') throw new Error('Expected pending recording');
  const binding = screenRecordingPendingCompletionBinding(record.envelope, completion);
  if (!binding) throw new Error('Expected pending completion binding');
  screenRecordingResourceStore.write(resourcePath, {
    ...record.envelope,
    metadata: {
      ...record.envelope.metadata,
      pendingCompletionBinding: binding,
    },
  });
  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    {
      kind: 'open',
      resourcePath: manifestPath(harness.sessionStore),
      pendingCompletion: completion,
    },
  );
  expect(screenRecordingManifestIsTerminal(harness.params)).toBe(false);
  const secondChunk = completion.chunks?.[1];
  if (!secondChunk) throw new Error('Expected second video chunk');
  fs.rmSync(secondChunk.path);
  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    { kind: 'open', resourcePath },
  );
  fs.writeFileSync(secondChunk.path, 'mp4');
  fs.rmSync(harness.videoPath);
  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    {
      kind: 'open',
      resourcePath: manifestPath(harness.sessionStore),
    },
  );
});

test('a session with no recording manifest has nothing to recover', () => {
  const harness = makeHarness();

  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    { kind: 'none' },
  );
  expect(screenRecordingManifestIsTerminal(harness.params)).toBe(false);
});

function fullCompletion(outPath: string): ScreenRecordingCompletion {
  return {
    backend: 'simctl',
    outPath,
    startedAt: 1,
    completedAt: 4,
    capturedDurationMs: 3,
    stopObservation: { recorder: 'lost', why: 'owner-session-lost' },
    nativePathDisposition: 'pending',
    scope: 'app',
    showTouches: true,
    recordOnlySession: false,
    clientOutPath: '/workspace/capture.mp4',
    telemetryPath: '/workspace/capture.gesture-telemetry.json',
    warning: 'recording was truncated at the platform limit',
    overlayWarning: 'touch overlay burn-in is only available on macOS hosts',
    activeSessionApp: { bundleId: 'dev.example.app', name: 'Example' },
    chunks: [
      { index: 1, path: outPath, clientOutPath: '/workspace/capture-0.mp4' },
      { index: 2, path: path.join(path.dirname(outPath), 'capture.part-002.mp4') },
    ],
  };
}

function writeCompletionVideos(completion: ScreenRecordingCompletion): void {
  fs.writeFileSync(completion.outPath, 'mp4');
  for (const chunk of completion.chunks ?? []) fs.writeFileSync(chunk.path, 'mp4');
}

function withStoredCompletion(metadata: JsonObject, patch: JsonObject): JsonObject {
  const completion = metadata.completion as JsonObject;
  return { ...metadata, completion: { ...completion, ...patch } };
}

function makeHarness() {
  const sessionStore = makeCaptureAdmissionSessionStore<DurableCaptureSessionState>(
    'screen-recording-stop-recovery-',
  );
  const outputDir = mkdtempForTestSync('screen-recording-stop-recovery-output-');
  return {
    sessionStore,
    videoPath: path.join(outputDir, 'capture.mp4'),
    params: { sessionName: SESSION_NAME, sessionStore },
  };
}

type Harness = ReturnType<typeof makeHarness>;

function manifestPath(
  sessionStore: CaptureAdmissionSessionStore<DurableCaptureSessionState>,
): string {
  return screenRecordingResourceStore.resolvePath(sessionStore.resolveSessionDir(SESSION_NAME));
}

async function completeRecording(
  harness: Harness,
  optional: Readonly<{ clientOutPath?: string; telemetryPath?: string }> = {},
) {
  fs.writeFileSync(harness.videoPath, 'mp4');
  const completion = {
    backend: 'adb screenrecord',
    outPath: harness.videoPath,
    startedAt: 1,
    completedAt: 2,
    scope: 'app' as const,
    showTouches: true,
    recordOnlySession: false,
    ...(optional.clientOutPath ? { clientOutPath: optional.clientOutPath } : {}),
    ...(optional.telemetryPath ? { telemetryPath: optional.telemetryPath } : {}),
  };
  writeManifest(harness, encodeScreenRecordingCompletionMetadata(completion));
  return completion;
}

function writeManifest(
  harness: Harness,
  metadata: JsonObject | undefined,
  overrides: {
    sessionId?: string;
    device?: ReturnType<typeof deviceIdentity>;
    lifecycle?: 'open' | 'completed';
  } = {},
): void {
  screenRecordingResourceStore.write(
    manifestPath(harness.sessionStore),
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: overrides.sessionId ?? SESSION_NAME,
      device: overrides.device ?? deviceIdentity(SESSION_DEVICE),
      owner: localRuntimeOwner(SESSION_DEVICE.platform),
      fence: { token: 'screen-recording-fence', generation: 1 },
      lifecycle: overrides.lifecycle ?? 'completed',
      descriptor: { version: 1, body: { recordingId: 'recording-id' } },
      ...(metadata === undefined ? {} : { metadata }),
    }),
  );
}
