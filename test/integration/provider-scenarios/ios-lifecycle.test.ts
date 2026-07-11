import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import { assertFlatToolCall } from './assertions.ts';
import {
  createIosBottomTabsSnapshotWorld,
  createIosPhysicalReinstallWorld,
  createIosSettingsWorld,
} from './ios-world.ts';
import { runProviderScenario } from './scenario.ts';
import {
  PROVIDER_SCENARIO_IOS_REINSTALL_DEVICE,
  PROVIDER_SCENARIO_IOS_SIMULATOR,
} from './fixtures.ts';
import { withProviderScenarioResource } from './harness.ts';

test('Provider-backed integration iOS Settings flow uses scripted simctl and runner providers', async () => {
  await withProviderScenarioResource(
    createIosSettingsWorld,
    async ({ appPath, appleTool, daemon, inventoryRequests, runnerTranscript }) => {
      const scopedDevices = await daemon.client().devices.list({
        platform: 'ios',
        iosSimulatorDeviceSet: '/tmp/provider-scenario-simulators',
      });
      assert.equal(scopedDevices.length, 1);
      assert.equal(scopedDevices[0]?.id, PROVIDER_SCENARIO_IOS_SIMULATOR.id);

      await runProviderScenario(daemon, [
        {
          name: 'open settings app',
          command: 'open',
          positionals: ['com.apple.Preferences'],
          flags: { platform: 'ios', udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id },
          expectData: {
            appBundleId: 'com.apple.Preferences',
            device_udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
          },
        },
        {
          name: 'read app session state',
          command: 'appstate',
          flags: { platform: 'ios', udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id },
          expectData: {
            platform: 'ios',
            appBundleId: 'com.apple.Preferences',
            source: 'session',
            device_udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
            ios_simulator_device_set: null,
          },
        },
        {
          name: 'prepare iOS runner',
          command: 'prepare',
          positionals: ['ios-runner'],
          flags: { platform: 'ios', udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id },
          expectData: {
            action: 'ios-runner',
            platform: 'ios',
            deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
            runner: { uptimeMs: 42 },
          },
        },
        {
          name: 'capture settings snapshot',
          command: 'snapshot',
          flags: { snapshotInteractiveOnly: true },
          assert: (firstSnapshot) => {
            assert.equal(firstSnapshot.json?.result?.data?.nodes?.[0]?.label, 'General');
            assert.equal(firstSnapshot.json?.result?.data?.nodes?.[0]?.ref, 'e1');
          },
        },
        {
          name: 'reopen existing session app',
          command: 'open',
          positionals: ['com.apple.Preferences'],
          expectData: { appBundleId: 'com.apple.Preferences' },
        },
        {
          name: 'capture iOS launch console while reopening app',
          command: 'open',
          positionals: ['com.apple.Preferences'],
          flags: {
            launchConsole: path.join(path.dirname(appPath), 'launch-console.log'),
          },
          expectData: { appBundleId: 'com.apple.Preferences' },
        },
        {
          name: 'reinstall demo app',
          command: 'reinstall',
          positionals: ['com.example.demo', appPath],
          expectData: { platform: 'ios', bundleId: 'com.example.demo', appPath },
        },
        {
          name: 'install demo app',
          command: 'install',
          positionals: ['com.example.demo', appPath],
          expectData: { platform: 'ios', bundleId: 'com.example.demo', appPath },
        },
        {
          name: 'list user apps by default',
          command: 'apps',
          assert: (apps) => {
            assert.deepEqual(apps.json?.result?.data?.apps, ['Demo (com.example.demo)']);
          },
        },
        {
          name: 'list all apps with flag',
          command: 'apps',
          flags: { appsFilter: 'all' },
          assert: (apps) => {
            assert.deepEqual(apps.json?.result?.data?.apps, [
              'Maps (com.apple.Maps)',
              'Demo (com.example.demo)',
            ]);
          },
        },
        {
          name: 'refresh snapshot after install',
          command: 'snapshot',
          flags: { snapshotInteractiveOnly: true },
        },
        {
          name: 'press snapshot ref',
          command: 'press',
          positionals: ['@e1'],
          expectData: { x: 196, y: 122 },
        },
        {
          name: 'pinch current app',
          command: 'gesture',
          input: { kind: 'pinch', scale: 0.8, origin: { x: 196, y: 122 } },
          expectData: {
            kind: 'pinch',
            durationMs: 300,
            pointerCount: 2,
            from: { x: 196, y: 122 },
            to: { x: 196, y: 122 },
          },
        },
        {
          name: 'pan current app',
          command: 'gesture',
          input: {
            kind: 'pan',
            origin: { x: 196, y: 122 },
            delta: { x: 80, y: 0 },
            durationMs: 500,
          },
          expectData: {
            kind: 'pan',
            durationMs: 500,
            pointerCount: 1,
            from: { x: 196, y: 122 },
            to: { x: 276, y: 122 },
          },
        },
        {
          name: 'fling current app',
          command: 'gesture',
          input: {
            kind: 'fling',
            direction: 'right',
            origin: { x: 196, y: 122 },
            distance: 180,
          },
          expectData: {
            kind: 'fling',
            durationMs: 100,
            pointerCount: 1,
            from: { x: 196, y: 122 },
            to: { x: 376, y: 122 },
          },
        },
        {
          name: 'rotate current app content',
          command: 'gesture',
          input: { kind: 'rotate', degrees: 35, origin: { x: 196, y: 122 } },
          expectData: {
            kind: 'rotate',
            durationMs: 300,
            pointerCount: 2,
            from: { x: 196, y: 122 },
            to: { x: 196, y: 122 },
          },
        },
        {
          name: 'transform current app content',
          command: 'gesture',
          input: {
            kind: 'transform',
            origin: { x: 196, y: 122 },
            delta: { x: 40, y: -20 },
            scale: 1.5,
            degrees: 35,
            durationMs: 700,
          },
          expectData: {
            kind: 'transform',
            durationMs: 700,
            pointerCount: 2,
            from: { x: 196, y: 122 },
            to: { x: 236, y: 102 },
          },
        },
        {
          name: 'get ref attrs',
          command: 'get',
          positionals: ['attrs', '@e1'],
          assert: (getAttrs) => {
            assert.equal(getAttrs.json?.result?.data?.node?.label, 'General');
          },
        },
        {
          name: 'assert visible selector',
          command: 'is',
          positionals: ['visible', 'label=General'],
          expectData: { pass: true },
        },
        {
          name: 'find attrs by label',
          command: 'find',
          positionals: ['label', 'General', 'get', 'attrs'],
          expectData: { ref: '@e1' },
        },
        {
          name: 'wait for text',
          command: 'wait',
          positionals: ['text', 'General', '100'],
          expectData: { text: 'General' },
        },
        {
          name: 'navigate with explicit system back mode',
          command: 'back',
          flags: { backMode: 'system' },
          expectData: { mode: 'system' },
        },
        {
          name: 'write clipboard',
          command: 'clipboard',
          positionals: ['write', 'runner otp 246810'],
          expectData: { textLength: 17 },
        },
        {
          name: 'read clipboard',
          command: 'clipboard',
          positionals: ['read'],
          expectData: { text: 'runner otp 246810' },
        },
        {
          name: 'dismiss keyboard',
          command: 'keyboard',
          positionals: ['dismiss'],
          expectData: { platform: 'ios', action: 'dismiss', dismissed: true },
        },
        {
          name: 'list active iOS session',
          command: 'session_list',
          assert: (list) => {
            const sessions = list.json?.result?.data?.sessions;
            assert.equal(sessions?.length, 1);
            assert.equal(sessions?.[0]?.name, 'default');
            assert.equal(sessions?.[0]?.platform, 'ios');
            assert.equal(sessions?.[0]?.device_udid, PROVIDER_SCENARIO_IOS_SIMULATOR.id);
            assert.equal(sessions?.[0]?.ios_simulator_device_set, null);
          },
        },
        { name: 'close settings session', command: 'close' },
        {
          name: 'list sessions after close',
          command: 'session_list',
          assert: (list) => {
            assert.deepEqual(list.json?.result?.data?.sessions, []);
          },
        },
      ]);

      runnerTranscript.assertComplete();
      assertFlatToolCall(appleTool.calls, ['simctl', 'launch', 'sim-1', 'com.apple.Preferences']);
      assertFlatToolCall(appleTool.calls, [
        'simctl',
        'launch',
        '--console-pty',
        'sim-1',
        'com.apple.Preferences',
      ]);
      assertFlatToolCall(appleTool.calls, ['simctl', 'uninstall', 'sim-1', 'com.example.demo']);
      assertFlatToolCall(appleTool.calls, ['plist', 'readJson', path.join(appPath, 'Info.plist')]);
      assertFlatToolCall(appleTool.calls, ['simctl', 'install', 'sim-1', appPath]);
      assertFlatToolCall(appleTool.calls, ['simctl', 'pbcopy', 'sim-1']);
      assertFlatToolCall(appleTool.calls, ['simctl', 'pbpaste', 'sim-1']);
      assert.ok(
        inventoryRequests.some(
          (request) => request.iosSimulatorSetPath === '/tmp/provider-scenario-simulators',
        ),
        JSON.stringify(inventoryRequests),
      );
    },
  );
});

test('Provider-backed integration iOS regular snapshot preserves fixed bottom tabs after scroll content', async () => {
  await withProviderScenarioResource(
    createIosBottomTabsSnapshotWorld,
    async ({ daemon, runnerTranscript }) => {
      await daemon.callCommand('open', ['org.reactnavigation.playground'], {
        platform: 'ios',
        udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      });

      const snapshot = await daemon.callCommand('snapshot');
      const data = snapshot.json?.result?.data;
      const nodes = data?.nodes ?? [];
      assert.equal(data?.truncated, false);
      assert.ok(
        nodes.some((node: { identifier?: string }) => node.identifier === 'article'),
        JSON.stringify(nodes),
      );
      assert.ok(
        nodes.some((node: { identifier?: string }) => node.identifier === 'contacts'),
        JSON.stringify(nodes),
      );
      assert.ok(
        nodes.some((node: { identifier?: string }) => node.identifier === 'albums'),
        JSON.stringify(nodes),
      );
      assert.equal(
        nodes.find((node: { label?: string }) => node.label === 'Contacts')?.hiddenContentBelow,
        true,
      );
      runnerTranscript.assertComplete();
    },
  );
});

test('Provider-backed integration iOS physical reinstall uses scripted devicectl provider', async () => {
  await withProviderScenarioResource(
    createIosPhysicalReinstallWorld,
    async ({ appPath, appleTool, daemon }) => {
      const boot = await daemon.callCommand('boot', [], {
        platform: 'ios',
        udid: PROVIDER_SCENARIO_IOS_REINSTALL_DEVICE.id,
      });
      assert.equal(boot.statusCode, 200, JSON.stringify(boot.json));
      assert.equal(boot.json?.result?.data?.platform, 'ios');
      assert.equal(boot.json?.result?.data?.id, PROVIDER_SCENARIO_IOS_REINSTALL_DEVICE.id);
      assert.equal(boot.json?.result?.data?.booted, true);

      const reinstall = await daemon.callCommand('reinstall', ['com.example.demo', appPath], {
        platform: 'ios',
        udid: PROVIDER_SCENARIO_IOS_REINSTALL_DEVICE.id,
      });
      assert.equal(reinstall.statusCode, 200, JSON.stringify(reinstall.json));
      assert.equal(reinstall.json?.result?.data?.platform, 'ios');
      assert.equal(reinstall.json?.result?.data?.bundleId, 'com.example.demo');
      assert.equal(reinstall.json?.result?.data?.appPath, appPath);
      assertFlatToolCall(appleTool.calls, [
        'devicectl',
        'device',
        'uninstall',
        'app',
        '--device',
        PROVIDER_SCENARIO_IOS_REINSTALL_DEVICE.id,
        'com.example.demo',
      ]);
      assertFlatToolCall(appleTool.calls, [
        'devicectl',
        'device',
        'install',
        'app',
        '--device',
        PROVIDER_SCENARIO_IOS_REINSTALL_DEVICE.id,
        appPath,
      ]);
    },
  );
});
