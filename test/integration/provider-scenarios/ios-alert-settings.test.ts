import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { AppLogProvider } from '../../../src/daemon/app-log.ts';
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
      request: { command: 'alert', action: 'get', appBundleId: 'com.apple.Preferences' },
      result: { title: 'Camera Access', message: 'Allow Settings to access Camera?' },
    },
    {
      command: 'ios.runner.alert',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: { command: 'alert', action: 'accept', appBundleId: 'com.apple.Preferences' },
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
  const appLogProvider: AppLogProvider = {
    start: async ({ appBundleId, outPath }) => {
      appLogStarts.push({ appBundleId, outPath });
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.appendFileSync(outPath, 'Settings log stream started\n', 'utf8');
      return {
        backend: 'ios-simulator',
        startedAt: Date.now(),
        getState: () => 'active',
        stop: async () => {
          appLogStopCount += 1;
        },
        wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      };
    },
  };
  const daemon = await createProviderScenarioHarness({
    appLogProvider: () => appLogProvider,
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
