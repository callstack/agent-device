import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';
import { assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioTempDir } from './harness.ts';
import {
  androidAdbResult,
  buildAndroidRecordingManifest,
  stopAndroidRecording,
  withAndroidProviderScenarioEnv,
} from './android-recording-fixtures.ts';

test('Provider-backed integration Android record stop retries the pull until in-place moov finalization lands', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-finalize-race-',
    runAndroidRemoteFinalizeRaceScenario,
  );
}, 15_000);

async function runAndroidRemoteFinalizeRaceScenario(tmpDir: string): Promise<void> {
  const remotePath = '/sdcard/agent-device-recording-523456789.mp4';
  const recordingPath = path.join(tmpDir, 'finalize-race.mp4');
  const recordingSize = 3232;
  const streamingBytes = unfinalizedMp4Container(recordingSize);
  const finalizedBytes = finalizedMp4Container(recordingSize);
  // screenrecord finalizes by patching a front-reserved moov in place: the size never changes,
  // only the content does, so the copy path must detect finalization from re-pulled bytes.
  assert.equal(streamingBytes.length, finalizedBytes.length);
  const manifest = buildAndroidRecordingManifest({
    outPath: recordingPath,
    remotePath,
    sessionName: 'default',
  });
  let pullCount = 0;
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => {
      const command = args.join(' ');
      if (command === 'shell cat /sdcard/agent-device-recording-active.json') {
        return { stdout: JSON.stringify(manifest), stderr: '', exitCode: 0 };
      }
      if (command === 'shell ps -o pid=,args= -p 4321') {
        return {
          stdout: `4321 screenrecord --bit-rate 8000000 ${remotePath}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      return androidAdbResult(args);
    },
    pull: async (from, to) => {
      pullCount += 1;
      assert.equal(from, remotePath);
      // Finalization lands after the second pull, past the first retry delay — inside the
      // 1-3s window observed live on a loaded emulator.
      fs.writeFileSync(to, pullCount <= 2 ? streamingBytes : finalizedBytes);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => adbProvider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  await withAndroidProviderScenarioEnv(tmpDir, async () => {
    try {
      const recordStop = await stopAndroidRecording(daemon, recordingPath);
      const data = assertRpcOk<{ recording?: unknown; outPath?: unknown }>(recordStop);
      assert.equal(data.recording, 'stopped');
      assert.equal(data.outPath, recordingPath);
      assert.equal(pullCount, 3);
      assert.equal(fs.existsSync(recordingPath), true);
    } finally {
      await daemon.close();
    }
  });
}

// A screenrecord capture pulled mid-finalization: the moov space is still a `free` placeholder.
function unfinalizedMp4Container(totalSize: number): Buffer {
  return mp4WithMoovSlot('free', totalSize);
}

// The same capture after screenrecord patched the reserved slot into a real moov atom.
function finalizedMp4Container(totalSize: number): Buffer {
  return mp4WithMoovSlot('moov', totalSize);
}

function mp4WithMoovSlot(slotType: 'free' | 'moov', totalSize: number): Buffer {
  const ftyp = mp4Atom('ftyp', Buffer.from('isom0000isom', 'latin1'));
  const slot = mp4Atom(slotType, Buffer.alloc(1024));
  const mdat = mp4Atom('mdat', Buffer.alloc(totalSize - ftyp.length - slot.length - 8));
  return Buffer.concat([ftyp, slot, mdat]);
}

function mp4Atom(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, payload]);
}
