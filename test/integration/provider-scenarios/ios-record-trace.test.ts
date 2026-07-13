import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { RecordingProvider } from '../../../src/daemon/recording-provider.ts';
import {
  assertFlatToolCallStartsWith,
  assertRecordingStarted,
  assertRecordingStopped,
} from './assertions.ts';
import { PROVIDER_SCENARIO_IOS_DEVICE, PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import {
  createProviderScenarioHarness,
  likelyPlayableMp4Container,
  restoreEnv,
  withProviderScenarioTempDir,
} from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlListDevicesHandler,
} from './providers.ts';
import { createProviderTranscript } from './transcript.ts';

test('Provider-backed integration iOS physical recording flow uses runner and devicectl providers', async () => {
  await withProviderScenarioTempDir('agent-device-provider-scenario-ios-record-', (tmpDir) =>
    runPhysicalRecordingScenario(tmpDir),
  );
});

type ScenarioDaemon = Awaited<ReturnType<typeof createProviderScenarioHarness>>;

async function runPhysicalRecordingScenario(tmpDir: string): Promise<void> {
  const tracePath = path.join(tmpDir, 'trace.adtrace');
  const finalTracePath = path.join(tmpDir, 'trace-final.adtrace');
  const recordingPath = path.join(tmpDir, 'recording.mp4');
  const invalidRecordingPath = path.join(tmpDir, 'invalid-recording.mp4');
  const runnerFailurePath = path.join(tmpDir, 'runner-failure.mp4');
  const harness = await createPhysicalRecordingHarness();
  const previousPath = process.env.PATH;
  const previousSwiftCacheDir = process.env.AGENT_DEVICE_SWIFT_CACHE_DIR;
  process.env.PATH = tmpDir;
  process.env.AGENT_DEVICE_SWIFT_CACHE_DIR = path.join(tmpDir, 'swift-cache');

  try {
    await openPhysicalSettings(harness.daemon);
    const traceStart = await harness.daemon.callCommand('trace', ['start', tracePath]);
    assert.equal(traceStart.json?.result?.data?.trace, 'started');
    await recordPhysicalHappyPath(harness.daemon, recordingPath);
    harness.setCopiedRecording(Buffer.from('unfinalized-recording'));
    await recordAndExpectFailure(harness.daemon, invalidRecordingPath, /not finalized/);
    harness.setCopiedRecording(likelyPlayableMp4Container());
    await recordAndExpectFailure(harness.daemon, runnerFailurePath, /runner reported recordStop/);
    const traceStop = await harness.daemon.callCommand('trace', ['stop', finalTracePath]);
    assert.equal(traceStop.json?.result?.data?.trace, 'stopped');
    assertPhysicalRecordingEvidence(harness, recordingPath, finalTracePath);
  } finally {
    await harness.daemon.close();
    restoreEnv('PATH', previousPath);
    restoreEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', previousSwiftCacheDir);
  }
}

async function createPhysicalRecordingHarness() {
  let copiedRecording = likelyPlayableMp4Container();
  const runnerStartEntry = {
    command: 'ios.runner.recordStart',
    deviceId: PROVIDER_SCENARIO_IOS_DEVICE.id,
    platform: 'apple' as const,
    result: {},
  };
  const runnerStopEntry = {
    command: 'ios.runner.recordStop',
    deviceId: PROVIDER_SCENARIO_IOS_DEVICE.id,
    platform: 'apple' as const,
    request: { command: 'recordStop', appBundleId: 'com.apple.Preferences' },
    result: {},
  };
  const runnerTranscript = createProviderTranscript([
    runnerStartEntry,
    runnerStopEntry,
    runnerStartEntry,
    runnerStopEntry,
    runnerStartEntry,
    { ...runnerStopEntry, result: undefined, error: 'runner reported recordStop ok:0' },
  ]);
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(
    runnerTranscript,
    'ios.runner',
  );
  const appleTool = createRecordingAppleToolProvider({
    devicectl: async (args) => {
      writeJsonOutputIfRequested(args);
      writeCopiedRecordingIfRequested(args, copiedRecording);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const daemon = await createProviderScenarioHarness({
    appleRunnerProvider: () => appleRunnerProvider,
    appleToolProvider: () => appleTool.provider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_DEVICE],
  });
  return {
    daemon,
    runnerTranscript,
    appleTool,
    setCopiedRecording(contents: Buffer) {
      copiedRecording = contents;
    },
  };
}

async function openPhysicalSettings(daemon: ScenarioDaemon): Promise<void> {
  const open = await daemon.callCommand('open', ['com.apple.Preferences'], {
    platform: 'ios',
    udid: PROVIDER_SCENARIO_IOS_DEVICE.id,
  });
  assert.equal(open.statusCode, 200, JSON.stringify(open.json));
  assert.equal(open.json?.result?.data?.device_udid, PROVIDER_SCENARIO_IOS_DEVICE.id);
}

async function recordPhysicalHappyPath(daemon: ScenarioDaemon, outPath: string): Promise<void> {
  const start = await daemon.callCommand(
    'record',
    ['start', outPath],
    { fps: 30, screenshotMaxSize: 720, quality: 'high', hideTouches: true },
    { meta: { requestId: 'ios-physical-record-start' } },
  );
  assertRecordingStarted(start, { showTouches: false });
  const stop = await daemon.callCommand(
    'record',
    ['stop'],
    {},
    { meta: { requestId: 'ios-physical-record-stop' } },
  );
  assertRecordingStopped(stop, outPath, { showTouches: false });
}

async function recordAndExpectFailure(
  daemon: ScenarioDaemon,
  outPath: string,
  message: RegExp,
): Promise<void> {
  const start = await daemon.callCommand('record', ['start', outPath], { hideTouches: true });
  assertRecordingStarted(start, { showTouches: false });
  const stop = await daemon.callCommand('record', ['stop']);
  assert.equal(stop.statusCode, 200, JSON.stringify(stop.json));
  assert.equal(stop.json?.result, undefined);
  assert.equal(stop.json?.error?.data?.code, 'COMMAND_FAILED');
  assert.match(String(stop.json?.error?.data?.message), message);
  assert.equal(fs.existsSync(outPath), true);
}

function assertPhysicalRecordingEvidence(
  harness: Awaited<ReturnType<typeof createPhysicalRecordingHarness>>,
  recordingPath: string,
  finalTracePath: string,
): void {
  harness.runnerTranscript.assertComplete();
  const recordStartCall = harness.runnerTranscript.calls.find(
    (call) => call.command === 'ios.runner.recordStart',
  );
  const request = recordStartCall?.request as Record<string, unknown> | undefined;
  assert.deepEqual(
    {
      command: request?.command,
      fps: request?.fps,
      maxSize: request?.maxSize,
      appBundleId: request?.appBundleId,
    },
    {
      command: 'recordStart',
      fps: 30,
      maxSize: 720,
      appBundleId: 'com.apple.Preferences',
    },
  );
  assert.match(String(request?.outPath), /^agent-device-recording-\d+\.mp4$/);
  assert.equal(fs.existsSync(recordingPath), true);
  assert.equal(fs.existsSync(finalTracePath), true);
  assertFlatToolCallStartsWith(harness.appleTool.calls, [
    'devicectl',
    'device',
    'info',
    'details',
    '--device',
    PROVIDER_SCENARIO_IOS_DEVICE.id,
  ]);
  assertFlatToolCallStartsWith(harness.appleTool.calls, [
    'devicectl',
    'device',
    'process',
    'launch',
    '--device',
    PROVIDER_SCENARIO_IOS_DEVICE.id,
    'com.apple.Preferences',
  ]);
  assertFlatToolCallStartsWith(harness.appleTool.calls, [
    'devicectl',
    'device',
    'copy',
    'from',
    '--device',
    PROVIDER_SCENARIO_IOS_DEVICE.id,
  ]);
}

test('Provider-backed integration iOS simulator recording flow uses semantic recording provider', async () => {
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
        simctl: simctlListDevicesHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
          { name: 'iPhone 15', udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id },
        ]),
      });
      const recordingStarts: string[] = [];
      let stopped = false;
      const recordingProvider: RecordingProvider = {
        startIosSimulatorRecording: ({ device, outPath }) => {
          assert.equal(device.id, PROVIDER_SCENARIO_IOS_SIMULATOR.id);
          recordingStarts.push(outPath);
          fs.writeFileSync(outPath, likelyPlayableMp4Container());
          return {
            child: {
              kill: (signal) => {
                assert.equal(signal, 'SIGINT');
                stopped = true;
                return true;
              },
            },
            wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
          };
        },
      };
      const daemon = await createProviderScenarioHarness({
        appleRunnerProvider: () => appleRunnerProvider,
        appleToolProvider: () => appleTool.provider,
        recordingProvider: () => recordingProvider,
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

        const recordStop = await daemon.callCommand(
          'record',
          ['stop'],
          {},
          { meta: { requestId: 'ios-simulator-record-stop' } },
        );
        assertRecordingStopped(recordStop, recordingPath, { showTouches: false });

        runnerTranscript.assertComplete();
        assert.deepEqual(recordingStarts, [recordingPath]);
        assert.equal(stopped, true);
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

function writeCopiedRecordingIfRequested(args: string[], contents: Buffer): void {
  const destinationIndex = args.indexOf('--destination');
  const destination = destinationIndex >= 0 ? args[destinationIndex + 1] : undefined;
  if (!destination) return;
  fs.writeFileSync(destination, contents);
}
