import assert from 'node:assert/strict';
import { test } from 'vitest';
import { IOS_DEVICE } from '../../../__tests__/test-utils/device-fixtures.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { RunnerCommand } from '../../../platforms/apple/core/runner/runner-contract.ts';
import type { RecordTraceDeps } from '../record-trace-types.ts';
import { startIosDeviceRecording } from '../record-trace-ios.ts';

test('startIosDeviceRecording stops stale runner recording and retries with the same request id', async () => {
  const sessionStore = makeSessionStore('agent-device-record-trace-ios-');
  const activeSession = {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    device: IOS_DEVICE,
    appBundleId: 'com.example.app',
  };
  sessionStore.set('default', activeSession);

  const runnerCalls: Array<{ command: RunnerCommand; requestId?: string }> = [];
  const deps: RecordTraceDeps = {
    runCmd: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    startIosSimulatorRecording: () => {
      throw new Error('not used');
    },
    runAppleRunnerCommand: async (_device, command, options) => {
      runnerCalls.push({ command, requestId: options?.requestId });
      if (command.command === 'recordStart' && runnerCalls.length === 1) {
        throw new Error('recording already in progress');
      }
      return { recorderStartUptimeMs: 100, targetAppReadyUptimeMs: 130 };
    },
    waitForRecordingTail: async () => {},
    waitForStableFile: async () => {},
    isPlayableVideo: async () => true,
    trimRecordingStart: async () => {},
    resizeRecording: async () => {},
    overlayRecordingTouches: async () => {},
  };

  const result = await startIosDeviceRecording({
    req: {
      token: 'test-token',
      session: 'default',
      command: 'record',
      positionals: ['start', '/tmp/recording.mp4'],
      flags: {},
      meta: { requestId: 'req-stale-recording' },
    },
    activeSession,
    sessionStore,
    device: IOS_DEVICE,
    deps,
    fpsFlag: undefined,
    recordingBase: {
      outPath: '/tmp/recording.mp4',
      startedAt: 1,
      showTouches: true,
      gestureEvents: [],
    },
    appBundleId: 'com.example.app',
  });

  assert.deepEqual(
    runnerCalls.map((call) => ({
      command: call.command.command,
      requestId: call.requestId,
    })),
    [
      { command: 'recordStart', requestId: 'req-stale-recording' },
      { command: 'recordStop', requestId: 'req-stale-recording' },
      { command: 'recordStart', requestId: 'req-stale-recording' },
    ],
  );
  if ('ok' in result) {
    assert.fail(`expected recording state, got response: ${JSON.stringify(result)}`);
  }
  assert.equal(result.platform, 'ios-device-runner');
  assert.equal(result.runnerStartedAtUptimeMs, 100);
  assert.equal(result.targetAppReadyUptimeMs, 130);
});
