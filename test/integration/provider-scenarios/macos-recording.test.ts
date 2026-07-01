import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertRecordingStarted, assertRecordingStopped, assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_MACOS } from './fixtures.ts';
import { createProviderScenarioTempPath, withProviderScenarioResource } from './harness.ts';
import { createMacOsDesktopWorld } from './macos-world.ts';
import { createAppleRunnerProviderFromTranscript } from './providers.ts';
import { createProviderTranscript } from './transcript.ts';

test('Provider-backed integration macOS recording flow uses runner provider through daemon path', async () => {
  const recordingPath = createProviderScenarioTempPath(
    'agent-device-provider-scenario-macos-record',
    'mp4',
  );
  const runnerTranscript = createProviderTranscript([
    {
      command: 'macos.runner.recordStart',
      deviceId: PROVIDER_SCENARIO_MACOS.id,
      platform: 'apple',
      request: {
        command: 'recordStart',
        outPath: recordingPath,
        fps: 30,
        maxSize: 1024,
        appBundleId: 'com.apple.systempreferences',
      },
      result: {},
    },
    {
      command: 'macos.runner.recordStop',
      deviceId: PROVIDER_SCENARIO_MACOS.id,
      platform: 'apple',
      request: { command: 'recordStop', appBundleId: 'com.apple.systempreferences' },
      result: {},
    },
  ]);
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(
    runnerTranscript,
    'macos.runner',
  );
  await withProviderScenarioResource(
    async () => await createMacOsDesktopWorld({ appleRunnerProvider }),
    async ({ daemon }) => {
      const open = await daemon.callCommand('open', ['settings'], { platform: 'macos' });
      assert.equal(assertRpcOk(open).appBundleId, 'com.apple.systempreferences');

      const recordStart = await daemon.callCommand('record', ['start', recordingPath], {
        hideTouches: true,
        fps: 30,
        screenshotMaxSize: 1024,
      });
      assertRecordingStarted(recordStart, { outPath: recordingPath, showTouches: false });

      const recordStop = await daemon.callCommand('record', ['stop']);
      assertRecordingStopped(recordStop, recordingPath, { showTouches: false });

      runnerTranscript.assertComplete();
    },
  );
});
