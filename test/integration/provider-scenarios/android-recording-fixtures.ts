import path from 'node:path';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import type { JsonObject } from '@agent-device/contracts/client';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity } from '@agent-device/kernel/device';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import type { AndroidRecordingManifestFixture } from './android-recording-manifest-fixtures.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioTempDir } from './harness.ts';

export type ProviderScenarioDaemon = Awaited<ReturnType<typeof createProviderScenarioHarness>>;
export type ProviderScenarioRpcResult = Awaited<ReturnType<ProviderScenarioDaemon['callCommand']>>;

export async function stopAndroidRecording(
  daemon: ProviderScenarioDaemon,
  outputPath?: string,
): Promise<ProviderScenarioRpcResult> {
  return await daemon.callCommand('record', outputPath ? ['stop', outputPath] : ['stop'], {
    platform: 'android',
    serial: PROVIDER_SCENARIO_ANDROID.id,
  });
}

/**
 * The daemon's host for an Android recording scenario: no real tool on its PATH, so the Swift
 * helpers cannot compile, and a Swift cache of its own.
 */
function androidRecordingHostEnv(tmpDir: string): Readonly<Record<string, string>> {
  return { PATH: tmpDir, AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(tmpDir, 'swift-cache') };
}

export async function createAndroidRecordingScenarioHarness(
  deps: Parameters<typeof createProviderScenarioHarness>[0],
  tmpDir: string,
): Promise<ProviderScenarioDaemon> {
  return await createProviderScenarioHarness({
    ...deps,
    env: { ...androidRecordingHostEnv(tmpDir), ...deps.env },
  });
}

export async function withAndroidRecordingScenario<T>(
  prefix: string,
  run: (tmpDir: string) => Promise<T>,
): Promise<T> {
  return await withProviderScenarioTempDir(prefix, run);
}

export function seedAndroidRecordingResource(
  daemon: ProviderScenarioDaemon,
  manifest: AndroidRecordingManifestFixture,
  options: { descriptor?: JsonObject } = {},
): void {
  const remotePath = manifest.chunks.at(-1)?.remotePath ?? manifest.pendingRemotePath;
  if (!remotePath) throw new Error('Android recording fixture needs a native remote path');
  const manifestPath = `${path.posix.dirname(remotePath)}/agent-device-recording-active.json`;
  screenRecordingResourceStore.write(
    screenRecordingResourceStore.resolvePath(daemon.sessionDir(manifest.sessionId)),
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: manifest.sessionId,
      device: deviceIdentity(PROVIDER_SCENARIO_ANDROID),
      owner: localRuntimeOwner('android'),
      fence: { token: manifest.fenceToken, generation: manifest.fenceGeneration },
      lifecycle: 'open',
      descriptor: {
        version: 1,
        body: options.descriptor ?? {
          backend: 'adb-screenrecord',
          manifestPath,
          outputPath: manifest.outputPath,
          scope: manifest.scope,
          showTouches: manifest.showTouches,
          recordOnlySession: manifest.recordOnlySession,
          ...(manifest.exportQuality === undefined
            ? {}
            : { exportQuality: manifest.exportQuality }),
          transportMode: manifest.transportMode,
        },
      },
    }),
  );
}
