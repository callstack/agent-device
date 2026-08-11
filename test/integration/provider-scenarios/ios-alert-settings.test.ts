import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  providerRuntimeOwner,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import { createAppLogStartResult, createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { createTestAppLogLiveHandle } from '../../../src/__tests__/test-utils/app-log-live-handle.ts';
import { assertFlatToolCall } from './assertions.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness } from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlListDevicesResult,
} from './providers.ts';
import { createProviderTranscript } from './transcript.ts';

test('Provider-backed integration iOS Settings permission and alert flow uses provider seams', async () => {
  const runnerTranscript = createProviderTranscript([
    {
      command: 'ios.runner.alert',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: {
        command: 'alert',
        action: 'get',
        appBundleId: 'com.apple.Preferences',
        timeoutMs: 10_000,
      },
      result: { title: 'Camera Access', message: 'Allow Settings to access Camera?' },
    },
    {
      command: 'ios.runner.alert',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: {
        command: 'alert',
        action: 'get',
        appBundleId: 'com.apple.Preferences',
        timeoutMs: 37,
      },
      result: { title: 'Camera Access', message: 'Allow Settings to access Camera?' },
    },
    {
      command: 'ios.runner.alert',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: {
        command: 'alert',
        action: 'accept',
        appBundleId: 'com.apple.Preferences',
        timeoutMs: 10_000,
      },
      result: { action: 'accept', accepted: true },
    },
  ]);
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(
    runnerTranscript,
    'ios.runner',
  );
  const appleTool = createRecordingAppleToolProvider({
    simctl: async (args) => {
      const listDevices = simctlListDevicesResult(
        args,
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
        [{ name: 'iPhone 15', udid: 'sim-1' }],
      );
      if (listDevices) {
        return listDevices;
      }
      if (args.join(' ') === 'privacy help') {
        return {
          stdout: [
            'service',
            '  camera - Camera',
            '  microphone - Microphone',
            'bundle identifier',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args.join(' ') === 'help') {
        return { stdout: 'simctl help\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  let appLogStopCount = 0;
  const appLogStarts: Array<{ appBundleId: string; outPath: string }> = [];
  const deviceRuntimeGateway = createRecordingPlatformRuntimeGateway({
    starts: appLogStarts,
    stopped: () => {
      appLogStopCount += 1;
    },
  });
  const daemon = await createProviderScenarioHarness({
    deviceRuntimeGateway,
    appleRunnerProvider: () => appleRunnerProvider,
    appleToolProvider: () => appleTool.provider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
  });

  try {
    {
      const client = daemon.client();
      const selection = { platform: 'ios' as const, udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id };

      const open = await client.apps.open({ app: 'com.apple.Preferences', ...selection });
      assert.equal(open.device?.id, PROVIDER_SCENARIO_IOS_SIMULATOR.id);

      const logsPath = await client.observability.logs({ action: 'path', ...selection });
      assert.equal(logsPath.active, false);

      const logsStart = await client.observability.logs({ action: 'start', ...selection });
      assert.equal(logsStart.started, true);

      const activeLogsPath = await client.observability.logs({ action: 'path', ...selection });
      assert.equal(activeLogsPath.active, true);
      assert.equal(activeLogsPath.backend, 'ios-simulator');

      const logsClearRestart = await client.observability.logs({
        action: 'clear',
        restart: true,
        ...selection,
      });
      assert.equal(logsClearRestart.cleared, true);
      assert.equal(logsClearRestart.restarted, true);

      const logsStop = await client.observability.logs({ action: 'stop', ...selection });
      assert.equal(logsStop.stopped, true);

      const logsMark = await client.observability.logs({
        action: 'mark',
        message: 'before-camera-permission',
        ...selection,
      });
      assert.equal(logsMark.marked, true);
      assert.match(fs.readFileSync(String(logsMark.path), 'utf8'), /before-camera-permission/);

      const logsDoctor = await client.observability.logs({ action: 'doctor', ...selection });
      assert.equal((logsDoctor.checks as { simctlAvailable?: boolean }).simctlAvailable, true);

      await client.settings.update({ setting: 'appearance', state: 'dark', ...selection });

      await client.settings.update({
        setting: 'location',
        state: 'set',
        latitude: 37.3349,
        longitude: -122.009,
        ...selection,
      });

      await client.settings.update({
        setting: 'permission',
        state: 'grant',
        permission: 'camera',
        ...selection,
      });

      const alertGet = await client.command.alert({ action: 'get', ...selection });
      assert.equal(alertGet.title, 'Camera Access');

      const alertWait = await client.command.alert({ action: 'wait', timeoutMs: 37, ...selection });
      assert.equal(alertWait.title, 'Camera Access');

      const alertAccept = await client.command.alert({ action: 'accept', ...selection });
      assert.equal(alertAccept.accepted, true);
    }

    runnerTranscript.assertComplete();
    assert.deepEqual(
      appLogStarts.map((start) => start.appBundleId),
      ['com.apple.Preferences', 'com.apple.Preferences'],
    );
    assert.equal(appLogStopCount, 2);
    assertFlatToolCall(appleTool.calls, ['simctl', 'ui', 'sim-1', 'appearance', 'dark']);
    assertFlatToolCall(appleTool.calls, ['simctl', 'location', 'sim-1', 'set', '37.3349,-122.009']);
    assertFlatToolCall(appleTool.calls, [
      'simctl',
      'privacy',
      'sim-1',
      'grant',
      'camera',
      'com.apple.Preferences',
    ]);
  } finally {
    await daemon.close();
  }
});

function createRecordingPlatformRuntimeGateway(params: {
  starts: Array<{ appBundleId: string; outPath: string }>;
  stopped(): void;
}): DeviceRuntimeGateway<PlatformRuntimeOperations> {
  const owner = providerRuntimeOwner('provider-scenario', 'ios-settings');
  return {
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind: async ({ device }) => {
      if (device.platform !== 'apple' || !device.appleOs) {
        throw new TypeError('The iOS provider scenario requires an explicit Apple leaf');
      }
      const appleOs = device.appleOs;
      return {
        device,
        owner,
        facts: {
          device: {
            family: 'apple',
            appleOs,
            kind: device.kind,
            ...(device.target === undefined ? {} : { target: device.target }),
            providerMode: 'provider-runtime',
          },
          operations: {
            appLogInspect: { available: true },
            appLogDoctor: { available: true },
            appLogStart: { available: true },
            appLogReattach: { available: true },
            appLogCleanup: { available: true },
            networkDump: {
              available: false,
              reason: 'unsupported-provider-mode',
            },
            screenRecordingStart: unavailableRecording,
            screenRecordingReattach: unavailableRecording,
            screenRecordingCleanup: unavailableRecording,
            ensureReady: { available: true },
            bootTarget: unavailableRecording,
            bootTargetHeadless: unavailableRecording,
            listApps: unavailableRecording,
          },
        },
        operations: {
          appLogInspect: async () => ({ backend: 'ios-simulator' }),
          appLogDoctor: async () => ({
            backend: 'ios-simulator',
            checks: { simctlAvailable: true },
            notes: [],
          }),
          appLogStart: async (input) => {
            params.starts.push({ appBundleId: input.appBundleId, outPath: input.outputPath });
            fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
            fs.appendFileSync(input.outputPath, 'Settings log stream started\n', 'utf8');
            let completion:
              | Promise<{
                  status: 'completed';
                  result: {
                    backend: 'ios-simulator';
                    outputPath: string;
                    completedAt: number;
                  };
                }>
              | undefined;
            const finish = async () =>
              (completion ??= (async () => {
                params.stopped();
                return {
                  status: 'completed' as const,
                  result: {
                    backend: 'ios-simulator' as const,
                    outputPath: input.outputPath,
                    completedAt: Date.now(),
                  },
                };
              })());
            const handle = createTestAppLogLiveHandle({
              inspect: () => ({
                backend: 'ios-simulator',
                state: 'active',
                startedAt: Date.now(),
              }),
              finish,
              forceCleanup: async () => {
                await finish();
                return { status: 'cleaned' };
              },
            });
            return createAppLogStartResult(
              handle,
              createDurableResourceEnvelope({
                resourceKind: 'app-log',
                sessionId: input.sessionId,
                device: {
                  id: device.id,
                  family: 'apple',
                  appleOs,
                  kind: device.kind,
                  ...(device.target === undefined ? {} : { target: device.target }),
                },
                owner,
                fence: input.fence,
                lifecycle: 'open',
                descriptor: { version: 1, body: { transport: 'provider-scenario' } },
              }),
            );
          },
          appLogReattach: async () => ({ status: 'missing' }),
          appLogCleanup: async () => ({ status: 'already-missing' }),
        },
        [Symbol.asyncDispose]: async () => {},
      };
    },
    shutdown: async () => {},
  };
}

const unavailableRecording = Object.freeze({
  available: false as const,
  reason: 'unsupported-provider-mode' as const,
});
