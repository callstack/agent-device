import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { JsonObject } from '@agent-device/contracts/client';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceIdentity } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { encodeScreenRecordingCompletionMetadata } from '../screen-recording-completion-metadata.ts';
import { screenRecordingResourceStore } from '../screen-recording-resource-store.ts';
import {
  resolveScreenRecordingStopRecovery,
  screenRecordingManifestIsTerminal,
} from '../screen-recording-stop-recovery.ts';
import type { SessionStore } from '../session-store.ts';

const SESSION_NAME = 'recording';
const SESSION_DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
};

test('a completed manifest hands its surviving export to a later stop', async () => {
  const harness = makeHarness();
  const completion = await completeRecording(harness, {
    clientOutPath: '/workspace/capture.mp4',
    telemetryPath: '/workspace/capture.gesture-telemetry.json',
  });

  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    { kind: 'completed', completion },
  );
  expect(screenRecordingManifestIsTerminal(harness.params)).toBe(true);
});

test('a completed manifest with no surviving video serves nothing', async () => {
  const harness = makeHarness();
  await completeRecording(harness);
  fs.rmSync(harness.videoPath);

  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    { kind: 'none' },
  );
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

test('a session with no recording manifest has nothing to recover', () => {
  const harness = makeHarness();

  expect(resolveScreenRecordingStopRecovery({ ...harness.params, device: SESSION_DEVICE })).toEqual(
    { kind: 'none' },
  );
  expect(screenRecordingManifestIsTerminal(harness.params)).toBe(false);
});

function makeHarness() {
  const sessionStore = makeSessionStore('screen-recording-stop-recovery-');
  const outputDir = mkdtempForTestSync('screen-recording-stop-recovery-output-');
  return {
    sessionStore,
    videoPath: path.join(outputDir, 'capture.mp4'),
    params: { sessionName: SESSION_NAME, sessionStore },
  };
}

type Harness = ReturnType<typeof makeHarness>;

function manifestPath(sessionStore: SessionStore): string {
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
