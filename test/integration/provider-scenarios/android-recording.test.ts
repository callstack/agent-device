import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { ANDROID_RECORDING_CONTRACT_EVIDENCE } from './android-recording.coverage.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import {
  createAndroidRecordingScenarioHarness,
  seedAndroidRecordingResource,
  stopAndroidRecording,
  withAndroidRecordingScenario,
} from './android-recording-fixtures.ts';
import { buildAndroidRecordingManifest } from './android-recording-manifest-fixtures.ts';
import {
  createAndroidRecordingProvider,
  type PullCall,
} from './android-recording-provider-fixtures.ts';

test(ANDROID_RECORDING_CONTRACT_EVIDENCE.testName, async () => {
  await withAndroidRecordingScenario(
    'agent-device-provider-scenario-android-record-',
    async (tmpDir) => {
      const calls: string[][] = [];
      const pulls: PullCall[] = [];
      const outputPath = path.join(tmpDir, 'sessionless.mp4');
      const daemon = await createAndroidRecordingScenarioHarness({
        androidAdbProvider: () => createAndroidRecordingProvider({ calls, pulls }),
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      });
      try {
        const started = await daemon.callCommand('record', ['start', outputPath], {
          platform: 'android',
          serial: PROVIDER_SCENARIO_ANDROID.id,
          recordingScope: 'device',
          quality: 'high',
        });
        assert.equal(assertRpcOk<{ recording?: unknown }>(started).recording, 'started');
        const stopped = await stopAndroidRecording(daemon, outputPath);
        assert.equal(
          assertRpcOk<{ recording?: unknown; outPath?: unknown }>(stopped).recording,
          'stopped',
        );
        assert.equal(assertRpcOk<{ outPath?: unknown }>(stopped).outPath, outputPath);
        assert.ok(calls.some((args) => args[1]?.startsWith('screenrecord --bit-rate 20000000 ')));
        assert.ok(calls.some((args) => args.join(' ') === 'shell kill -2 4321'));
        assert.equal(pulls.length, 1);
        assert.equal(pulls[0]?.localPath, outputPath);
        assert.equal(fs.existsSync(outputPath), true);
      } finally {
        await daemon.close();
      }
    },
  );
});

test('Provider-backed integration Android record stop reattaches a matching durable descriptor', async () => {
  await withAndroidRecordingScenario(
    'agent-device-provider-scenario-android-recovery-',
    async (tmpDir) => {
      const calls: string[][] = [];
      const pulls: PullCall[] = [];
      const outputPath = path.join(tmpDir, 'recovered.mp4');
      const remotePath = '/sdcard/agent-device-recording-123456789.mp4';
      const manifest = buildAndroidRecordingManifest({
        outPath: outputPath,
        remotePath,
        sessionName: 'default',
      });
      const daemon = await createAndroidRecordingScenarioHarness({
        androidAdbProvider: () =>
          createAndroidRecordingProvider({ calls, pulls, manifests: [manifest] }),
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      });
      seedAndroidRecordingResource(daemon, manifest);
      try {
        const stopped = await stopAndroidRecording(daemon, outputPath);
        const data = assertRpcOk<{ recording?: unknown; outPath?: unknown }>(stopped);
        assert.equal(data.recording, 'stopped');
        assert.equal(data.outPath, outputPath);
        assert.ok(
          calls.some((args) => args[1]?.includes('/sdcard/agent-device-recording-active.json')),
        );
        assert.ok(calls.some((args) => args.join(' ') === 'shell kill -2 4321'));
        assert.deepEqual(pulls, [{ remotePath, localPath: outputPath }]);
      } finally {
        await daemon.close();
      }
    },
  );
});

test('Provider-backed integration Android record stop returns fenced completed native evidence', async () => {
  await withAndroidRecordingScenario(
    'agent-device-provider-scenario-android-completed-',
    async (tmpDir) => {
      const calls: string[][] = [];
      const outputPath = path.join(tmpDir, 'completed.mp4');
      const manifest = buildAndroidRecordingManifest({
        outPath: outputPath,
        remotePath: '/sdcard/agent-device-recording-223456789.mp4',
        sessionName: 'default',
        completion: {
          backend: 'adb screenrecord',
          outPath: outputPath,
          startedAt: 123456789,
          completedAt: 123456999,
          scope: 'device',
          showTouches: true,
          recordOnlySession: false,
        },
      });
      const daemon = await createAndroidRecordingScenarioHarness({
        androidAdbProvider: () =>
          createAndroidRecordingProvider({ calls, manifests: [manifest], deadPids: ['4321'] }),
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      });
      seedAndroidRecordingResource(daemon, manifest);
      try {
        const stopped = await stopAndroidRecording(daemon, outputPath);
        assert.equal(
          assertRpcOk<{ recording?: unknown; outPath?: unknown }>(stopped).recording,
          'stopped',
        );
        assert.equal(assertRpcOk<{ outPath?: unknown }>(stopped).outPath, outputPath);
        assert.equal(
          calls.some((args) => args[0] === 'pull' || args[1]?.startsWith('kill ')),
          false,
        );
      } finally {
        await daemon.close();
      }
    },
  );
});

test('Provider-backed integration Android corrupt descriptor is retained without native cleanup', async () => {
  await withAndroidRecordingScenario(
    'agent-device-provider-scenario-android-corrupt-',
    async (tmpDir) => {
      const calls: string[][] = [];
      const manifest = buildAndroidRecordingManifest({
        outPath: path.join(tmpDir, 'corrupt.mp4'),
        remotePath: '/sdcard/agent-device-recording-323456789.mp4',
        sessionName: 'default',
      });
      const daemon = await createAndroidRecordingScenarioHarness({
        androidAdbProvider: () => createAndroidRecordingProvider({ calls, manifests: [manifest] }),
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      });
      seedAndroidRecordingResource(daemon, manifest, { descriptor: { malformed: true } });
      try {
        const stopped = await stopAndroidRecording(daemon);
        assertRpcError(stopped, 'COMMAND_FAILED', /cannot be reattached/);
        assert.equal(
          calls.some((args) => args[1]?.includes('agent-device-recording-active.json')),
          false,
        );
        assert.equal(
          fs.existsSync(path.join(daemon.sessionDir(), 'screen-recording.resource.json')),
          true,
        );
      } finally {
        await daemon.close();
      }
    },
  );
});

test('Provider-backed integration Android cleanup-only recovery terminalizes before a second start', async () => {
  await withAndroidRecordingScenario(
    'agent-device-provider-scenario-android-cleanup-',
    async (tmpDir) => {
      const calls: string[][] = [];
      const outputPath = path.join(tmpDir, 'retry.mp4');
      const manifest = buildAndroidRecordingManifest({
        outPath: outputPath,
        remotePath: '/sdcard/agent-device-recording-423456789.mp4',
        sessionName: 'default',
        chunks: [],
        pendingRemotePath: '/sdcard/agent-device-recording-423456789.mp4',
      });
      const provider = createAndroidRecordingProvider({ calls, manifests: [manifest] });
      const daemon = await createAndroidRecordingScenarioHarness({
        androidAdbProvider: () => provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      });
      seedAndroidRecordingResource(daemon, manifest);
      try {
        assertRpcError(
          await stopAndroidRecording(daemon),
          'COMMAND_FAILED',
          /launch was interrupted/,
        );
        const retried = await daemon.callCommand('record', ['start', outputPath], {
          platform: 'android',
          serial: PROVIDER_SCENARIO_ANDROID.id,
          recordingScope: 'device',
        });
        assert.equal(assertRpcOk<{ recording?: unknown }>(retried).recording, 'started');
        assert.ok(calls.some((args) => args[1]?.startsWith('screenrecord --bit-rate ')));
      } finally {
        await daemon.close();
      }
    },
  );
});
