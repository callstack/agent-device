import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import { assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import {
  createAndroidRecordingScenarioHarness,
  seedAndroidRecordingResource,
  stopAndroidRecording,
  withAndroidRecordingScenario,
} from './android-recording-fixtures.ts';
import { buildAndroidRecordingManifest } from './android-recording-manifest-fixtures.ts';
import { createAndroidRecordingProvider } from './android-recording-provider-fixtures.ts';

test('Provider-backed integration Android record stop finishes an artifact after a dead-pid reattach', async () => {
  await withAndroidRecordingScenario(
    'agent-device-provider-scenario-android-dead-pid-',
    async (tmpDir) => {
      const calls: string[][] = [];
      const outputPath = path.join(tmpDir, 'dead-pid-recovered.mp4');
      const remotePath = '/sdcard/agent-device-recording-623456789.mp4';
      const manifest = buildAndroidRecordingManifest({
        outPath: outputPath,
        remotePath,
        sessionName: 'default',
      });
      const daemon = await createAndroidRecordingScenarioHarness({
        androidAdbProvider: () => {
          const provider = createAndroidRecordingProvider({
            calls,
            manifests: [manifest],
            deadPids: ['4321'],
          });
          return provider;
        },
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      });
      seedAndroidRecordingResource(daemon, manifest);
      try {
        const stopped = await stopAndroidRecording(daemon, outputPath);
        const data = assertRpcOk<{ recording?: unknown; outPath?: unknown }>(stopped);
        assert.equal(data.recording, 'stopped');
        assert.equal(data.outPath, outputPath);
        assert.equal(
          calls.some((args) => args[1]?.startsWith('kill ')),
          false,
        );
      } finally {
        await daemon.close();
      }
    },
  );
});
