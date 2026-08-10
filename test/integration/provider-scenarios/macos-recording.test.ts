import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { assertRecordingStarted, assertRecordingStopped, assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_MACOS } from './fixtures.ts';
import { createProviderScenarioTempPath, withProviderScenarioResource } from './harness.ts';
import { createMacOsDesktopWorld } from './macos-world.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createAppleRunnerScreenRecordingTransportFromTranscript,
} from './providers.ts';
import { createProviderTranscript } from './transcript.ts';

test('Provider-backed integration macOS recording uses focused exact runner authority', async () => {
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
        appBundleId: 'com.apple.systempreferences',
      },
      result: { runnerSessionId: 'macos-runner-recording-1' },
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
  const appleRunnerScreenRecordingTransport =
    createAppleRunnerScreenRecordingTransportFromTranscript(
      runnerTranscript,
      'macos.runner',
      (outputPath) =>
        fs.copyFileSync(
          path.join(process.cwd(), 'website/docs/public/agent-device-contacts.mp4'),
          outputPath,
        ),
    );
  await withProviderScenarioResource(
    async () =>
      await createMacOsDesktopWorld({
        appleRunnerProvider,
        appleRunnerScreenRecordingTransport,
      }),
    async ({ daemon }) => {
      const open = await daemon.callCommand('open', ['settings'], { platform: 'macos' });
      assert.equal(assertRpcOk(open).appBundleId, 'com.apple.systempreferences');

      const recordStart = await daemon.callCommand('record', ['start', recordingPath], {
        hideTouches: true,
        fps: 30,
      });
      assertRecordingStarted(recordStart, { outPath: recordingPath, showTouches: false });

      const recordStop = await daemon.callCommand('record', ['stop']);
      assertRecordingStopped(recordStop, recordingPath, { showTouches: false });

      runnerTranscript.assertComplete();
    },
  );
});
