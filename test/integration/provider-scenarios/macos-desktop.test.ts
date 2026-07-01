import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { assertFlatToolCall, assertPngFile } from './assertions.ts';
import { PROVIDER_SCENARIO_MACOS } from './fixtures.ts';
import { createProviderScenarioTempPath, withProviderScenarioResource } from './harness.ts';
import { createMacOsDesktopWorld } from './macos-world.ts';
import { createAppleRunnerProviderFromTranscript } from './providers.ts';
import { runProviderScenario } from './scenario.ts';
import { createProviderTranscript } from './transcript.ts';
import type {
  AppleRunnerPrepareResult,
  AppleRunnerProvider,
} from '../../../src/platforms/apple/core/runner/runner-provider.ts';

test('Provider-backed integration prepare uses the Apple runner lifecycle provider', async () => {
  const lifecycleCalls: string[] = [];
  const appleRunnerProvider: AppleRunnerProvider = {
    runCommand: async () => {
      throw new Error('prepare should not be reduced to a raw runner command');
    },
    prepare: async (device): Promise<AppleRunnerPrepareResult> => {
      lifecycleCalls.push(`prepare:${device.platform}:${device.target ?? 'unknown'}`);
      return {
        runner: { uptimeMs: 123 },
        connectMs: 7,
        healthCheckMs: 11,
      };
    },
  };

  await withProviderScenarioResource(
    async () => await createMacOsDesktopWorld({ appleRunnerProvider }),
    async ({ daemon }) => {
      await runProviderScenario(daemon, [
        {
          name: 'prepare macOS runner',
          command: 'prepare',
          positionals: ['ios-runner'],
          flags: { platform: 'macos' },
          expectData: {
            action: 'ios-runner',
            platform: 'macos',
            deviceId: PROVIDER_SCENARIO_MACOS.id,
            runner: { uptimeMs: 123 },
            connectMs: 7,
            healthCheckMs: 11,
          },
        },
      ]);
    },
  );

  // The provider receives the internal collapsed DeviceInfo (platform:'apple',
  // appleOs:'macos'); the macOS distinction is carried by appleOs/target.
  assert.deepEqual(lifecycleCalls, ['prepare:apple:desktop']);
});

test('Provider-backed integration macOS desktop flow uses semantic host and helper providers', async () => {
  const runnerTranscript = createProviderTranscript([
    {
      command: 'macos.runner.uptime',
      deviceId: PROVIDER_SCENARIO_MACOS.id,
      platform: 'apple',
      request: { command: 'uptime' },
      result: { uptimeMs: 84 },
    },
    {
      command: 'macos.runner.desktopScroll',
      deviceId: PROVIDER_SCENARIO_MACOS.id,
      platform: 'apple',
      request: {
        command: 'desktopScroll',
        direction: 'down',
        pixels: 200,
        durationMs: 50,
        appBundleId: 'com.apple.systempreferences',
      },
      result: { x: 737.5, y: 476.5, referenceWidth: 400, referenceHeight: 800 },
    },
  ]);
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(
    runnerTranscript,
    'macos.runner',
  );
  await withProviderScenarioResource(
    async () => await createMacOsDesktopWorld({ appleRunnerProvider }),
    async ({ daemon, appleTool }) => {
      const screenshotPath = createProviderScenarioTempPath(
        'agent-device-provider-scenario-macos',
        'png',
      );
      try {
        await runProviderScenario(daemon, [
          {
            name: 'open settings app',
            command: 'open',
            positionals: ['settings'],
            flags: { platform: 'macos' },
          },
          {
            name: 'prepare macOS runner',
            command: 'prepare',
            positionals: ['ios-runner'],
            flags: { platform: 'macos' },
            expectData: {
              action: 'ios-runner',
              platform: 'macos',
              deviceId: PROVIDER_SCENARIO_MACOS.id,
              runner: { uptimeMs: 84 },
            },
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
                'Demo (com.example.demo)',
                'System Settings (com.apple.systempreferences)',
              ]);
            },
          },
          {
            name: 'read app session state',
            command: 'appstate',
            expectData: {
              platform: 'macos',
              appName: 'settings',
              appBundleId: 'com.apple.systempreferences',
              source: 'session',
              surface: 'app',
            },
          },
          {
            name: 'scroll app session with desktop wheel event',
            command: 'scroll',
            positionals: ['down'],
            flags: { pixels: 200, durationMs: 50 },
            expectData: {
              x1: 737.5,
              y1: 476.5,
              referenceWidth: 400,
              referenceHeight: 800,
              pixels: 200,
              durationMs: 50,
            },
          },
          {
            name: 'read logs path',
            command: 'logs',
            expectData: { active: false, backend: 'macos' },
            assert: (logsPath) => {
              assert.equal(typeof logsPath.json?.result?.data?.path, 'string');
            },
          },
          {
            name: 'write clipboard',
            command: 'clipboard',
            positionals: ['write', 'desktop otp 123456'],
            expectData: { textLength: 18 },
          },
          {
            name: 'read clipboard',
            command: 'clipboard',
            positionals: ['read'],
            expectData: { text: 'desktop otp 123456' },
          },
          {
            name: 'set dark appearance',
            command: 'settings',
            positionals: ['appearance', 'dark'],
            expectData: { setting: 'appearance', state: 'dark' },
          },
          {
            name: 'grant accessibility permission through helper',
            command: 'settings',
            positionals: ['permission', 'grant', 'accessibility'],
            expectData: {
              action: 'grant',
              target: 'accessibility',
              granted: true,
              requested: true,
              openedSettings: false,
            },
          },
          {
            name: 'reset screen recording permission through helper',
            command: 'settings',
            positionals: ['permission', 'reset', 'screen-recording'],
            expectData: {
              action: 'reset',
              target: 'screen-recording',
              granted: false,
              requested: true,
              openedSettings: false,
            },
          },
          {
            name: 'switch to frontmost desktop surface',
            command: 'open',
            flags: {
              platform: 'macos',
              surface: 'frontmost-app',
            },
            expectData: {
              surface: 'frontmost-app',
              appBundleId: 'com.apple.systempreferences',
            },
          },
          {
            name: 'read frontmost automation alert through helper',
            command: 'alert',
            positionals: ['get'],
            expectData: {
              title: 'System Events Wants to Control System Settings',
              role: 'AXSheet',
              action: 'get',
              bundleId: 'com.apple.systempreferences',
            },
          },
          {
            name: 'accept frontmost automation alert through helper',
            command: 'alert',
            positionals: ['accept'],
            expectData: {
              action: 'accept',
              bundleId: 'com.apple.systempreferences',
            },
          },
          {
            name: 'dismiss frontmost automation alert through helper',
            command: 'alert',
            positionals: ['dismiss'],
            expectData: {
              action: 'dismiss',
              bundleId: 'com.apple.systempreferences',
            },
          },
          {
            name: 'capture frontmost snapshot',
            command: 'snapshot',
            flags: { snapshotInteractiveOnly: true },
            assert: (snapshot) => {
              const general = snapshot.json?.result?.data?.nodes?.find(
                (node: { label?: string }) => node.label === 'General',
              );
              assert.equal(general?.ref, 'e2', JSON.stringify(snapshot.json));
              assert.equal(daemon.session()?.snapshot?.backend, 'macos-helper');
              assert.equal(daemon.session()?.snapshot?.nodes[0]?.surface, 'frontmost-app');
            },
          },
          {
            name: 'read snapshot ref text through helper',
            command: 'get',
            positionals: ['text', '@e2'],
            expectData: { text: 'System Settings General pane' },
          },
          {
            name: 'press snapshot ref',
            command: 'press',
            positionals: ['@e2'],
            expectData: { x: 116, y: 80 },
          },
          {
            name: 'switch to desktop surface',
            command: 'open',
            flags: {
              platform: 'macos',
              surface: 'desktop',
            },
            expectData: {
              surface: 'desktop',
              appBundleId: undefined,
            },
          },
          {
            name: 'read desktop surface state',
            command: 'appstate',
            expectData: {
              platform: 'macos',
              appName: 'desktop',
              appBundleId: undefined,
              source: 'session',
              surface: 'desktop',
            },
          },
          {
            name: 'capture fullscreen desktop screenshot with max-size',
            command: 'screenshot',
            flags: {
              out: screenshotPath,
              screenshotFullscreen: true,
              screenshotMaxSize: 1,
            },
            expectData: { path: screenshotPath },
            assert: () => {
              assertPngFile(screenshotPath);
            },
          },
          {
            name: 'capture desktop surface snapshot',
            command: 'snapshot',
            assert: (snapshot) => {
              assert.deepEqual(
                snapshot.json?.result?.data?.nodes?.map((node: { label?: string }) => node.label),
                ['Desktop', 'Notes', 'Notes', 'Pinned'],
              );
              assert.equal(daemon.session()?.snapshot?.backend, 'macos-helper');
              assert.equal(daemon.session()?.snapshot?.nodes[0]?.surface, 'desktop');
            },
          },
          {
            name: 'wait for desktop surface text through helper snapshot polling',
            command: 'wait',
            positionals: ['text', 'Notes', '100'],
            expectData: { text: 'Notes' },
          },
          {
            name: 'scope desktop snapshot after helper capture',
            command: 'snapshot',
            flags: { snapshotScope: 'Notes', snapshotDepth: 0 },
            assert: (snapshot) => {
              const nodes = snapshot.json?.result?.data?.nodes ?? [];
              assert.equal(nodes.length, 1, JSON.stringify(snapshot.json));
              assert.equal(nodes[0]?.label, 'Notes', JSON.stringify(snapshot.json));
              assert.equal(nodes[0]?.depth, 0, JSON.stringify(snapshot.json));
              assert.equal(nodes[0]?.parentIndex, undefined, JSON.stringify(snapshot.json));
              assert.equal(daemon.session()?.snapshot?.backend, 'macos-helper');
            },
          },
          {
            name: 'switch to menubar surface',
            command: 'open',
            flags: {
              platform: 'macos',
              surface: 'menubar',
            },
            expectData: {
              surface: 'menubar',
              appBundleId: undefined,
            },
          },
          {
            name: 'capture menubar surface snapshot',
            command: 'snapshot',
            assert: (snapshot) => {
              assert.deepEqual(
                snapshot.json?.result?.data?.nodes?.map((node: { label?: string }) => node.label),
                ['Menu Bar', 'File'],
              );
              assert.equal(daemon.session()?.snapshot?.backend, 'macos-helper');
              assert.equal(daemon.session()?.snapshot?.nodes[0]?.surface, 'menubar');
            },
          },
          {
            name: 'click menubar coordinates through helper-backed press path',
            command: 'click',
            positionals: ['100', '200'],
            expectData: { x: 100, y: 200 },
          },
          {
            name: 'switch to Demo menubar app surface',
            command: 'open',
            positionals: ['Demo'],
            flags: {
              platform: 'macos',
              surface: 'menubar',
            },
            expectData: {
              surface: 'menubar',
              appName: 'Demo',
              appBundleId: 'com.example.demo',
            },
          },
          {
            name: 'capture targeted menubar surface snapshot',
            command: 'snapshot',
            assert: (snapshot) => {
              assert.deepEqual(
                snapshot.json?.result?.data?.nodes?.map((node: { label?: string }) => node.label),
                ['Menu Bar', 'Demo'],
              );
              assert.equal(daemon.session()?.snapshot?.backend, 'macos-helper');
              assert.equal(daemon.session()?.snapshot?.nodes[1]?.bundleId, 'com.example.demo');
            },
          },
        ]);

        assertFlatToolCall(appleTool.calls, [
          'macos-host',
          'openBundle',
          'com.apple.systempreferences',
        ]);
        assertFlatToolCall(appleTool.calls, ['macos-host', 'listApps', 'all']);
        assertFlatToolCall(appleTool.calls, ['macos-host', 'writeClipboard', 'desktop otp 123456']);
        assertFlatToolCall(appleTool.calls, ['macos-host', 'readClipboard']);
        assertFlatToolCall(appleTool.calls, ['macos-host', 'setDarkMode', 'true']);
        assertFlatToolCall(appleTool.calls, [
          'macos-helper',
          'permission',
          'grant',
          'accessibility',
        ]);
        assertFlatToolCall(appleTool.calls, [
          'macos-helper',
          'permission',
          'reset',
          'screen-recording',
        ]);
        assertFlatToolCall(appleTool.calls, ['macos-helper', 'app', 'frontmost']);
        assertFlatToolCall(appleTool.calls, [
          'macos-helper',
          'alert',
          'get',
          '--surface',
          'frontmost-app',
        ]);
        assertFlatToolCall(appleTool.calls, [
          'macos-helper',
          'alert',
          'accept',
          '--surface',
          'frontmost-app',
        ]);
        assertFlatToolCall(appleTool.calls, [
          'macos-helper',
          'alert',
          'dismiss',
          '--surface',
          'frontmost-app',
        ]);
        assertFlatToolCall(appleTool.calls, [
          'macos-helper',
          'snapshot',
          '--surface',
          'frontmost-app',
        ]);
        assertFlatToolCall(appleTool.calls, ['macos-helper', 'snapshot', '--surface', 'desktop']);
        assert.ok(
          appleTool.calls.filter(
            (call) => call.join('\0') === 'macos-helper\0snapshot\0--surface\0desktop',
          ).length >= 2,
          'Expected desktop snapshot to be used by both snapshot and wait workflows',
        );
        assertFlatToolCall(appleTool.calls, ['macos-helper', 'snapshot', '--surface', 'menubar']);
        assertFlatToolCall(appleTool.calls, [
          'macos-helper',
          'screenshot',
          '--out',
          screenshotPath,
          '--surface',
          'desktop',
          '--fullscreen',
        ]);
        assertFlatToolCall(appleTool.calls, [
          'macos-helper',
          'read',
          '--x',
          '116',
          '--y',
          '80',
          '--bundle-id',
          'com.apple.systempreferences',
          '--surface',
          'frontmost-app',
        ]);
        assertFlatToolCall(appleTool.calls, [
          'macos-helper',
          'press',
          '--x',
          '116',
          '--y',
          '80',
          '--bundle-id',
          'com.apple.systempreferences',
          '--surface',
          'frontmost-app',
        ]);
        assertFlatToolCall(appleTool.calls, [
          'macos-helper',
          'press',
          '--x',
          '100',
          '--y',
          '200',
          '--surface',
          'menubar',
        ]);
        assertFlatToolCall(appleTool.calls, ['macos-host', 'openBundle', 'com.example.demo']);
        assertFlatToolCall(appleTool.calls, [
          'macos-helper',
          'snapshot',
          '--surface',
          'menubar',
          '--bundle-id',
          'com.example.demo',
        ]);
      } finally {
        fs.rmSync(screenshotPath, { force: true });
      }
      runnerTranscript.assertComplete();
    },
  );
});
