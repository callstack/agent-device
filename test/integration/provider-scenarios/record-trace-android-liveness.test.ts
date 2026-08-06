import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { assertCommandCall, assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioTempDir } from './harness.ts';
import {
  androidAdbResult,
  buildAndroidRecordingManifest,
  stopAndroidRecording,
  withAndroidProviderScenarioEnv,
  writePlayableMp4,
  type PullCall,
} from './android-recording-fixtures.ts';

test('Provider-backed integration Android record stop recovers finished recording after dead-pid probe', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-dead-pid-recovery-',
    runAndroidDeadPidRecoveryScenario,
  );
});

async function runAndroidDeadPidRecoveryScenario(tmpDir: string): Promise<void> {
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const remotePath = '/sdcard/agent-device-recording-623456789.mp4';
  const recordingPath = path.join(tmpDir, 'dead-pid-recovered.mp4');
  const manifest = buildAndroidRecordingManifest({
    outPath: recordingPath,
    remotePath,
    sessionName: 'default',
  });
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => ({
      exec: async (args) => {
        adbCalls.push([...args]);
        const command = args.join(' ');
        if (command === 'shell cat /sdcard/agent-device-recording-active.json') {
          return { stdout: JSON.stringify(manifest), stderr: '', exitCode: 0 };
        }
        // toybox signature for a pid that no longer exists: exit 1, no output at all.
        if (command === 'shell ps -o pid=,args= -p 4321') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        // The device is otherwise responsive: the full listing succeeds and shows no
        // screenrecord, and the finalized remote MP4 is present.
        if (command === 'shell ps -A -o pid=,args=') {
          return { stdout: '1 init\n', stderr: '', exitCode: 0 };
        }
        return androidAdbResult(args);
      },
      pull: async (from, to) => {
        pullCalls.push({ remotePath: from, localPath: to });
        writePlayableMp4(to);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  await withAndroidProviderScenarioEnv(tmpDir, async () => {
    try {
      const recordStop = await stopAndroidRecording(daemon, recordingPath);
      const data = assertRpcOk<{ recording?: unknown; outPath?: unknown; warning?: unknown }>(
        recordStop,
      );
      assert.equal(data.recording, 'stopped');
      assert.equal(data.outPath, recordingPath);
      assert.match(String(data.warning), /durable device manifest/);
      assert.match(String(data.warning), /no longer running/);
      assert.deepEqual(pullCalls, [{ remotePath, localPath: recordingPath }]);
      assert.equal(fs.existsSync(recordingPath), true);
      assertCommandCall(adbCalls, [
        'shell',
        'rm',
        '-f',
        '/sdcard/agent-device-recording-active.json',
      ]);
    } finally {
      await daemon.close();
    }
  });
}
