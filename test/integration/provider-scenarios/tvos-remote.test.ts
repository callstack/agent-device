import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_TVOS } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlListDevicesHandler,
} from './providers.ts';
import { createProviderTranscript } from './transcript.ts';

test('Provider-backed integration tvOS remote flow maps navigation commands to runner remote presses', async () => {
  const runnerTranscript = createProviderTranscript([
    {
      command: 'tvos.runner.remotePress',
      deviceId: PROVIDER_SCENARIO_TVOS.id,
      platform: 'apple',
      request: {
        command: 'remotePress',
        remoteButton: 'down',
        appBundleId: 'com.example.tv',
      },
      result: { remoteButton: 'down' },
    },
    {
      command: 'tvos.runner.remotePress',
      deviceId: PROVIDER_SCENARIO_TVOS.id,
      platform: 'apple',
      request: {
        command: 'remotePress',
        remoteButton: 'menu',
        appBundleId: 'com.example.tv',
      },
      result: { remoteButton: 'menu' },
    },
    {
      command: 'tvos.runner.remotePress',
      deviceId: PROVIDER_SCENARIO_TVOS.id,
      platform: 'apple',
      request: {
        command: 'remotePress',
        remoteButton: 'home',
        appBundleId: 'com.example.tv',
      },
      result: { remoteButton: 'home' },
    },
  ]);
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(
    runnerTranscript,
    'tvos.runner',
  );
  const appleTool = createRecordingAppleToolProvider({
    simctl: simctlListDevicesHandler('com.apple.CoreSimulator.SimRuntime.tvOS-18-0', [
      { name: 'Apple TV', udid: 'tv-sim-1' },
    ]),
  });

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        appleRunnerProvider: () => appleRunnerProvider,
        appleToolProvider: () => appleTool.provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_TVOS],
      }),
    async (daemon) => {
      const open = await daemon.callCommand('open', ['com.example.tv'], {
        platform: 'ios',
        target: 'tv',
        udid: PROVIDER_SCENARIO_TVOS.id,
      });
      assertRpcOk(open);

      const scroll = await daemon.callCommand('scroll', ['down']);
      assert.equal(assertRpcOk(scroll).direction, 'down');

      const back = await daemon.callCommand('back');
      assertRpcOk(back);

      const home = await daemon.callCommand('home');
      assertRpcOk(home);

      const close = await daemon.callCommand('close', ['com.example.tv']);
      assertRpcOk(close);

      runnerTranscript.assertComplete();
      assert.deepEqual(appleTool.calls, [
        ['simctl', 'list', 'devices', '-j'],
        ['simctl', 'list', 'devices', '-j'],
        ['simctl', 'launch', 'tv-sim-1', 'com.example.tv'],
        ['simctl', 'list', 'devices', '-j'],
        ['simctl', 'terminate', 'tv-sim-1', 'com.example.tv'],
      ]);
    },
  );
});
