import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { AppleSimulatorScreenRecordingTransport } from '../../../src/platform-runtime-screen-recording-apple-transport.ts';
import {
  assertFlatToolCallStartsWith,
  assertRecordingStarted,
  assertRecordingStopped,
} from './assertions.ts';
import { PROVIDER_SCENARIO_IOS_DEVICE, PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import {
  createProviderIosSimulatorRecordingProcess,
  createProviderScenarioHarness,
  restoreEnv,
  withProviderScenarioTempDir,
} from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlDeviceLifecycleHandler,
} from './providers.ts';
import { createProviderTranscript } from './transcript.ts';

test('generic scoped iOS physical runner recording fails closed without local fallback', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-ios-record-',
    async (tmpDir) => {
      const runnerTranscript = createProviderTranscript([]);
      const appleTool = createRecordingAppleToolProvider({
        devicectl: async (args) => {
          writeJsonOutputIfRequested(args);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      const daemon = await createProviderScenarioHarness({
        platformRuntime: true,
        appleRunnerProvider: () =>
          createAppleRunnerProviderFromTranscript(runnerTranscript, 'ios.runner'),
        appleToolProvider: () => appleTool.provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_DEVICE],
      });
      try {
        const open = await daemon.callCommand('open', ['com.apple.Preferences'], {
          platform: 'ios',
          udid: PROVIDER_SCENARIO_IOS_DEVICE.id,
        });
        assert.equal(open.json?.error, undefined, JSON.stringify(open.json));
        const start = await daemon.callCommand('record', [
          'start',
          path.join(tmpDir, 'recording.mp4'),
        ]);
        assert.equal(start.json?.error?.data?.code, 'UNSUPPORTED_OPERATION');
        assert.equal(start.json?.error?.data?.details?.reason, 'unsupported-provider-mode');
        runnerTranscript.assertComplete();
      } finally {
        await daemon.close();
      }
    },
  );
});

test('Provider-backed integration iOS simulator recording flow uses the focused Apple transport', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-ios-sim-record-',
    async (tmpDir) => {
      const recordingPath = path.join(tmpDir, 'sim-recording.mp4');
      const runnerTranscript = createProviderTranscript([]);
      const appleRunnerProvider = createAppleRunnerProviderFromTranscript(
        runnerTranscript,
        'ios.runner',
      );
      const appleTool = createRecordingAppleToolProvider({
        simctl: simctlDeviceLifecycleHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
          { name: 'iPhone 15', udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id },
        ]),
      });
      const recordingStarts: string[] = [];
      const recordingSignals: Array<NodeJS.Signals | number | undefined> = [];
      const recordingTransport: AppleSimulatorScreenRecordingTransport = {
        available: true,
        mode: 'transport-composed',
        start: ({ device, outputPath }) => {
          assert.equal(device.id, PROVIDER_SCENARIO_IOS_SIMULATOR.id);
          recordingStarts.push(outputPath);
          return createProviderIosSimulatorRecordingProcess(outputPath, (signal) => {
            recordingSignals.push(signal);
          });
        },
      };
      const daemon = await createProviderScenarioHarness({
        platformRuntime: true,
        appleRunnerProvider: () => appleRunnerProvider,
        appleToolProvider: () => appleTool.provider,
        appleSimulatorScreenRecordingTransport: () => recordingTransport,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
      });
      const previousPath = process.env.PATH;
      const previousSwiftCacheDir = process.env.AGENT_DEVICE_SWIFT_CACHE_DIR;
      process.env.PATH = tmpDir;
      process.env.AGENT_DEVICE_SWIFT_CACHE_DIR = path.join(tmpDir, 'swift-cache');

      try {
        const open = await daemon.callCommand('open', ['com.apple.Preferences'], {
          platform: 'ios',
          udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
        });
        assert.equal(open.statusCode, 200, JSON.stringify(open.json));
        assert.equal(open.json?.error, undefined, JSON.stringify(open.json));

        const recordStart = await daemon.callCommand(
          'record',
          ['start', recordingPath],
          {
            hideTouches: true,
          },
          { meta: { requestId: 'ios-simulator-record-start' } },
        );
        assertRecordingStarted(recordStart, { showTouches: false });
        const ownedProcessRecordPath = path.join(
          daemon.sessionDir('default'),
          'owned-processes.json',
        );
        const ownedProcessRecord = JSON.parse(fs.readFileSync(ownedProcessRecordPath, 'utf8')) as {
          version: number;
          processes: Array<{ purpose: string; pid: number }>;
        };
        assert.equal(ownedProcessRecord.version, 1);
        assert.ok(ownedProcessRecord.processes.length > 0);
        assert.ok(
          ownedProcessRecord.processes.every(
            ({ purpose, pid }) => purpose === 'simctl-screen-recording' && pid > 0,
          ),
        );

        const recordStop = await daemon.callCommand(
          'record',
          ['stop'],
          {},
          { meta: { requestId: 'ios-simulator-record-stop' } },
        );
        assertRecordingStopped(recordStop, recordingPath, { showTouches: false });
        assert.equal(fs.existsSync(ownedProcessRecordPath), false);

        runnerTranscript.assertComplete();
        assert.deepEqual(recordingStarts, [recordingPath]);
        assert.deepEqual(recordingSignals, ['SIGINT']);
        assertFlatToolCallStartsWith(appleTool.calls, [
          'simctl',
          'launch',
          PROVIDER_SCENARIO_IOS_SIMULATOR.id,
          'com.apple.Preferences',
        ]);
        assert.equal(
          appleTool.calls.some((call) => call.includes('recordVideo')),
          false,
        );
      } finally {
        await daemon.close();
        restoreEnv('PATH', previousPath);
        restoreEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', previousSwiftCacheDir);
      }
    },
  );
});

function writeJsonOutputIfRequested(args: string[]): void {
  const jsonOutputIndex = args.indexOf('--json-output');
  const jsonPath = jsonOutputIndex >= 0 ? args[jsonOutputIndex + 1] : undefined;
  if (!jsonPath) return;
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      result: {
        device: { connectionProperties: { tunnelState: 'connected' } },
      },
    }),
    'utf8',
  );
}
