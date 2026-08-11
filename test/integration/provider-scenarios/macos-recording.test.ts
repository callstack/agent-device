import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  assertRecordingStarted,
  assertRecordingStopped,
  assertRpcError,
  assertRpcOk,
} from './assertions.ts';
import { PROVIDER_SCENARIO_MACOS } from './fixtures.ts';
import {
  createProviderScenarioTempPath,
  type ProviderScenarioHarness,
  withProviderScenarioResource,
} from './harness.ts';
import { createMacOsDesktopWorld } from './macos-world.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createAppleRunnerScreenRecordingTransportFromTranscript,
} from './providers.ts';
import { screenRecordingResourceStore } from '../../../src/daemon/screen-recording-resource-store.ts';
import { createProviderTranscript } from './transcript.ts';

test('Provider-backed integration macOS recording uses focused exact runner authority', async () => {
  const recordingPath = createProviderScenarioTempPath(
    'agent-device-provider-scenario-macos-record',
    'mp4',
  );
  const { runnerTranscript, appleRunnerProvider, appleRunnerScreenRecordingTransport } =
    createMacOsRecordingScenario(recordingPath, (outputPath) =>
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

test('Provider-backed integration macOS recording rejects runner-stop failure and retains cleanup state', async () => {
  const recordingPath = createProviderScenarioTempPath(
    'agent-device-provider-scenario-macos-stop-failure',
    'mp4',
  );
  const stopError = 'macOS runner recordStop rejected';
  const { runnerTranscript, appleRunnerProvider, appleRunnerScreenRecordingTransport } =
    createMacOsRecordingScenario(recordingPath, undefined, stopError);

  await withProviderScenarioResource(
    async () =>
      await createMacOsDesktopWorld({
        appleRunnerProvider,
        appleRunnerScreenRecordingTransport,
      }),
    async ({ daemon }) => {
      await openMacOsSettings(daemon);

      const recordStart = await daemon.callCommand('record', ['start', recordingPath], {
        hideTouches: true,
        fps: 30,
      });
      assertRecordingStarted(recordStart, { outPath: recordingPath, showTouches: false });

      const recordStop = await daemon.callCommand('record', ['stop']);
      assertRpcError(recordStop, 'COMMAND_FAILED', /recordStop rejected/);
      assert.equal(recordStop.json?.result, undefined);

      const session = daemon.session();
      assert.ok(session?.screenRecording, 'failed stop must retain the live session resource');
      const resource = screenRecordingResourceStore.read(
        screenRecordingResourceStore.resolvePath(daemon.sessionDir()),
      );
      assert.equal(resource.status, 'decoded');
      if (resource.status === 'decoded') {
        assert.equal(resource.envelope.lifecycle, 'open');
        assert.equal(resource.envelope.metadata?.phase, 'cleanup-pending');
        assert.equal(resource.envelope.metadata?.cleanupStatus, 'cleanup-pending');
      }
      runnerTranscript.assertComplete();
    },
  );
});

test('Provider-backed integration macOS recording rejects an invalid MP4 before artifact publication', async () => {
  const recordingPath = createProviderScenarioTempPath(
    'agent-device-provider-scenario-macos-invalid-video',
    'mp4',
  );
  const { runnerTranscript, appleRunnerProvider, appleRunnerScreenRecordingTransport } =
    createMacOsRecordingScenario(recordingPath, (outputPath) =>
      fs.writeFileSync(outputPath, Buffer.from('not an MP4')),
    );

  await withProviderScenarioResource(
    async () =>
      await createMacOsDesktopWorld({
        appleRunnerProvider,
        appleRunnerScreenRecordingTransport,
      }),
    async ({ daemon }) => {
      await openMacOsSettings(daemon);

      const recordStart = await daemon.callCommand('record', ['start', recordingPath], {
        hideTouches: true,
        fps: 30,
      });
      assertRecordingStarted(recordStart, { outPath: recordingPath, showTouches: false });

      const recordStop = await daemon.callCommand('record', ['stop']);
      assertRpcError(recordStop, 'COMMAND_FAILED', /was not finalized into a playable video/);
      assert.equal(recordStop.json?.result, undefined);
      assert.equal(daemon.session()?.screenRecording, undefined);

      const resource = screenRecordingResourceStore.read(
        screenRecordingResourceStore.resolvePath(daemon.sessionDir()),
      );
      assert.equal(resource.status, 'decoded');
      if (resource.status === 'decoded') {
        assert.equal(resource.envelope.lifecycle, 'completed');
        assert.equal(resource.envelope.metadata?.phase, 'completed');
        assert.equal(resource.envelope.metadata?.cleanupStatus, 'cleaned');
      }
      runnerTranscript.assertComplete();
    },
  );
});

function createMacOsRecordingScenario(
  recordingPath: string,
  onStopped?: (outputPath: string) => void,
  stopError?: string,
) {
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
      ...(stopError === undefined ? { result: {} } : { error: stopError }),
    },
  ]);
  return {
    runnerTranscript,
    appleRunnerProvider: createAppleRunnerProviderFromTranscript(runnerTranscript, 'macos.runner'),
    appleRunnerScreenRecordingTransport: createAppleRunnerScreenRecordingTransportFromTranscript(
      runnerTranscript,
      'macos.runner',
      onStopped,
    ),
  };
}

async function openMacOsSettings(
  daemon: Pick<ProviderScenarioHarness, 'callCommand'>,
): Promise<void> {
  const open = await daemon.callCommand('open', ['settings'], { platform: 'macos' });
  assert.equal(assertRpcOk(open).appBundleId, 'com.apple.systempreferences');
}
