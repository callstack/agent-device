import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('Provider-backed integration Android record stop retries the pull until in-place moov finalization lands', async () => {
  await withAndroidRecordingScenario(
    'agent-device-provider-scenario-android-finalize-',
    async (tmpDir) => {
      const outputPath = path.join(tmpDir, 'finalize-race.mp4');
      const remotePath = '/sdcard/agent-device-recording-523456789.mp4';
      const manifest = buildAndroidRecordingManifest({
        outPath: outputPath,
        remotePath,
        sessionName: 'default',
      });
      const streaming = mp4WithMoovSlot('free');
      const finalized = mp4WithMoovSlot('moov');
      let pulls = 0;
      const daemon = await createAndroidRecordingScenarioHarness({
        androidAdbProvider: () =>
          createAndroidRecordingProvider({
            calls: [],
            manifests: [manifest],
            onPull: (_remotePath, localPath, count) => {
              pulls = count;
              fs.writeFileSync(localPath, count < 3 ? streaming : finalized);
            },
          }),
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      });
      seedAndroidRecordingResource(daemon, manifest);
      try {
        const stopped = await stopAndroidRecording(daemon, outputPath);
        assert.equal(assertRpcOk<{ recording?: unknown }>(stopped).recording, 'stopped');
        assert.equal(pulls, 3);
      } finally {
        await daemon.close();
      }
    },
  );
}, 15_000);

function mp4WithMoovSlot(slotType: 'free' | 'moov'): Buffer {
  const atom = (type: string, payload: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, 4, 'latin1');
    return Buffer.concat([header, payload]);
  };
  return Buffer.concat([
    atom('ftyp', Buffer.from('isom0000isom')),
    atom(slotType, Buffer.alloc(1024)),
    atom('mdat', Buffer.alloc(2048)),
  ]);
}
