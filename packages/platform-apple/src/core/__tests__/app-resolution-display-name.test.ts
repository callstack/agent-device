import { test } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveIosApp, resolveIosSimulatorDeepLinkBundleId } from '../app-resolution.ts';
import { withFakeAppleTool, type FakeAppleToolResponse } from '../../__tests__/fake-apple-tool.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

function unexpectedArgs(args: string[]): FakeAppleToolResponse {
  return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
}

function isDevicectlDevice(args: string[], ...subcommand: string[]): boolean {
  return (
    args[0] === 'devicectl' &&
    args[1] === 'device' &&
    subcommand.every((word, index) => args[2 + index] === word)
  );
}

test('resolveIosApp resolves app display name on iOS physical devices', async () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  };

  await withFakeAppleTool(
    (args) => {
      if (isDevicectlDevice(args, 'info', 'apps')) {
        const jsonOut = args[args.indexOf('--json-output') + 1];
        writeFileSync(
          jsonOut ?? '',
          '{"result":{"apps":[{"bundleIdentifier":"com.apple.Maps","name":"Maps"},{"bundleIdentifier":"com.example.demo","name":"Demo"}]}}\n',
        );
        return '';
      }
      return unexpectedArgs(args);
    },
    async () => {
      const bundleId = await resolveIosApp(device, 'Maps');
      assert.equal(bundleId, 'com.apple.Maps');
    },
  );
});

test('resolveIosApp caches display-name bundle matches but bypasses exact bundle ids', async () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'sim-cache-1',
    name: 'iPhone Cache',
    kind: 'simulator',
    booted: true,
  };

  await withFakeAppleTool(
    (args) => {
      if (args[0] === 'simctl' && args[1] === 'listapps') {
        return '{"com.example.cachemaps":{"CFBundleDisplayName":"Cache Maps"}}';
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      const first = await resolveIosApp(device, 'Cache Maps');
      const second = await resolveIosApp(device, 'Cache Maps');
      const exact = await resolveIosApp(device, 'com.example.cachemaps');

      assert.equal(first, 'com.example.cachemaps');
      assert.equal(second, 'com.example.cachemaps');
      assert.equal(exact, 'com.example.cachemaps');

      assert.equal(
        calls.filter((args) => args[0] === 'simctl' && args[1] === 'listapps').length,
        1,
      );
    },
  );
});

test('resolveIosSimulatorDeepLinkBundleId maps custom URL scheme to installed user app', async () => {
  const appPath = '/fake/ReactNavigationExample.app';
  const runnerPath = '/fake/AgentDeviceRunner.app';
  const listing = JSON.stringify({
    'com.callstack.agentdevice.runner': {
      ApplicationType: 'User',
      CFBundleDisplayName: 'AgentDeviceRunner',
      Path: runnerPath,
    },
    'org.reactnavigation.playground': {
      ApplicationType: 'User',
      CFBundleDisplayName: 'React Navigation Example',
      Path: appPath,
    },
  });

  await withFakeAppleTool(
    (args) => {
      if (args[0] === 'simctl' && args[1] === 'listapps') return listing;
      if (args[0] === 'plutil' && args[1] === '-convert') {
        const plistPath = args[5] ?? '';
        if (
          plistPath.endsWith('AgentDeviceRunner.app/Info.plist') ||
          plistPath.endsWith('ReactNavigationExample.app/Info.plist')
        ) {
          return '{"CFBundleURLTypes":[{"CFBundleURLSchemes":["rne"]}]}';
        }
        return '{}';
      }
      return unexpectedArgs(args);
    },
    async () => {
      const bundleId = await resolveIosSimulatorDeepLinkBundleId(
        IOS_TEST_SIMULATOR,
        'rne://navigator-layout',
      );
      assert.equal(bundleId, 'org.reactnavigation.playground');
    },
  );
});
