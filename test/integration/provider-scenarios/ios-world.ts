import fs from 'node:fs';
import path from 'node:path';
import type { DeviceInventoryRequest } from '../../../src/core/dispatch-resolve.ts';
import type { RawSnapshotNode } from '../../../src/kernel/snapshot.ts';
import type { ProviderScenarioTranscript } from './transcript.ts';
import {
  createDemoIosApp,
  PROVIDER_SCENARIO_IOS_REINSTALL_DEVICE,
  PROVIDER_SCENARIO_IOS_SIMULATOR,
} from './fixtures.ts';
import { createProviderScenarioHarness, type ProviderScenarioHarness } from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlListDevicesResult,
  type FlatToolCall,
} from './providers.ts';
import { createProviderTranscript } from './transcript.ts';

type IosSettingsWorld = {
  daemon: ProviderScenarioHarness;
  appleTool: { calls: FlatToolCall[] };
  runnerTranscript: ProviderScenarioTranscript;
  inventoryRequests: DeviceInventoryRequest[];
  appPath: string;
  close: () => Promise<void>;
};

export async function createIosSettingsWorld(): Promise<IosSettingsWorld> {
  const { tempRoot, appPath } = createDemoIosApp('agent-device-provider-scenario-ios-deploy-');
  const inventoryRequests: DeviceInventoryRequest[] = [];
  const runnerTranscript = createProviderTranscript([
    {
      command: 'ios.runner.uptime',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: { command: 'uptime' },
      result: { uptimeMs: 42 },
    },
    runnerSnapshot(),
    runnerSnapshot(),
    {
      command: 'ios.runner.tap',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: {
        command: 'tap',
        x: 196,
        y: 122,
        synthesized: true,
        appBundleId: 'com.apple.Preferences',
      },
      result: { tapped: true },
    },
    {
      command: 'ios.runner.pinch',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: {
        command: 'pinch',
        scale: 0.8,
        x: 196,
        y: 122,
        appBundleId: 'com.apple.Preferences',
      },
      result: { pinched: true },
    },
    {
      command: 'ios.runner.drag',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: {
        command: 'drag',
        x: 196,
        y: 122,
        x2: 276,
        y2: 122,
        durationMs: 500,
        synthesized: true,
        dragSemantics: 'pan',
        appBundleId: 'com.apple.Preferences',
      },
      result: { dragged: true },
    },
    {
      command: 'ios.runner.drag',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: {
        command: 'drag',
        x: 196,
        y: 122,
        x2: 376,
        y2: 122,
        durationMs: 50,
        synthesized: true,
        dragSemantics: 'fling',
        appBundleId: 'com.apple.Preferences',
      },
      result: { flung: true },
    },
    {
      command: 'ios.runner.rotateGesture',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: {
        command: 'rotateGesture',
        degrees: 35,
        x: 196,
        y: 122,
        velocity: 1,
        appBundleId: 'com.apple.Preferences',
      },
      result: { rotated: true },
    },
    {
      command: 'ios.runner.transformGesture',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: {
        command: 'transformGesture',
        x: 196,
        y: 122,
        dx: 40,
        dy: -20,
        scale: 1.5,
        degrees: 35,
        durationMs: 700,
        appBundleId: 'com.apple.Preferences',
      },
      result: { transformed: true },
    },
    runnerSnapshot(),
    {
      command: 'ios.runner.querySelector',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: {
        command: 'querySelector',
        selectorKey: 'label',
        selectorValue: 'General',
        appBundleId: 'com.apple.Preferences',
      },
      result: {
        found: true,
        nodes: [
          {
            index: 0,
            type: 'XCUIElementTypeCell',
            label: 'General',
            identifier: 'General',
            rect: { x: 16, y: 100, width: 360, height: 44 },
            enabled: true,
            hittable: true,
          },
        ],
      },
    },
    {
      command: 'ios.runner.findText',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: {
        command: 'findText',
        text: 'General',
        appBundleId: 'com.apple.Preferences',
      },
      result: { found: true },
    },
    {
      command: 'ios.runner.backSystem',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: { command: 'backSystem', appBundleId: 'com.apple.Preferences' },
      result: { backed: true },
    },
    {
      command: 'ios.runner.keyboardDismiss',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      request: { command: 'keyboardDismiss', appBundleId: 'com.apple.Preferences' },
      result: { dismissed: true },
    },
  ]);
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(
    runnerTranscript,
    'ios.runner',
  );
  let clipboardText = '';
  const appleTool = createRecordingAppleToolProvider({
    plist: {
      readJson: async (plistPath) => {
        if (plistPath === path.join(appPath, 'Info.plist')) {
          return {
            CFBundleIdentifier: 'com.example.demo',
            CFBundleDisplayName: 'Demo',
            CFBundleName: 'Demo',
          };
        }
        return null;
      },
    },
    simctl: async (args, options) => {
      if (args.join(' ') === 'pbcopy sim-1') {
        clipboardText = String(options?.stdin ?? '');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args.join(' ') === 'pbpaste sim-1') {
        return { stdout: `${clipboardText}\n`, stderr: '', exitCode: 0 };
      }
      const listDevices = simctlListDevicesResult(
        args,
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
        [{ name: 'iPhone 15', udid: 'sim-1' }],
      );
      if (listDevices) {
        return listDevices;
      }
      if (args.join(' ') === 'listapps sim-1') {
        return {
          stdout:
            '{"com.apple.Maps":{"CFBundleDisplayName":"Maps"},"com.example.demo":{"CFBundleDisplayName":"Demo"}}\n',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  const daemon = await createProviderScenarioHarness({
    appleRunnerProvider: () => appleRunnerProvider,
    appleToolProvider: () => appleTool.provider,
    deviceInventoryProvider: async (request) => {
      inventoryRequests.push({ ...request });
      return [PROVIDER_SCENARIO_IOS_SIMULATOR];
    },
  });
  let closed = false;
  return {
    daemon,
    appleTool,
    runnerTranscript,
    inventoryRequests,
    appPath,
    close: async () => {
      if (closed) return;
      closed = true;
      fs.rmSync(tempRoot, { recursive: true, force: true });
      await daemon.close();
    },
  };
}

type IosPhysicalReinstallWorld = {
  daemon: ProviderScenarioHarness;
  appleTool: { calls: FlatToolCall[] };
  appPath: string;
  close: () => Promise<void>;
};

type IosBottomTabsSnapshotWorld = {
  daemon: ProviderScenarioHarness;
  runnerTranscript: ProviderScenarioTranscript;
  close: () => Promise<void>;
};

export async function createIosBottomTabsSnapshotWorld(): Promise<IosBottomTabsSnapshotWorld> {
  const runnerTranscript = createProviderTranscript([
    {
      command: 'ios.runner.snapshot',
      deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      platform: 'apple',
      result: {
        nodes: bottomTabsContactSnapshotNodes(),
        truncated: false,
      },
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
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const daemon = await createProviderScenarioHarness({
    appleRunnerProvider: () => appleRunnerProvider,
    appleToolProvider: () => appleTool.provider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
  });
  let closed = false;
  return {
    daemon,
    runnerTranscript,
    close: async () => {
      if (closed) return;
      closed = true;
      await daemon.close();
    },
  };
}

export async function createIosPhysicalReinstallWorld(): Promise<IosPhysicalReinstallWorld> {
  const appleTool = createRecordingAppleToolProvider({
    devicectl: async (args) => {
      if (args.includes('info') && args.includes('details')) {
        const jsonOutputIndex = args.indexOf('--json-output');
        const jsonPath = jsonOutputIndex >= 0 ? args[jsonOutputIndex + 1] : undefined;
        if (jsonPath) {
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
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const daemon = await createProviderScenarioHarness({
    appleToolProvider: () => appleTool.provider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_REINSTALL_DEVICE],
  });
  const { tempRoot, appPath } = createDemoIosApp(
    'agent-device-provider-scenario-ios-physical-deploy-',
  );
  let closed = false;
  return {
    daemon,
    appleTool,
    appPath,
    close: async () => {
      if (closed) return;
      closed = true;
      fs.rmSync(tempRoot, { recursive: true, force: true });
      await daemon.close();
    },
  };
}

function runnerSnapshot() {
  return {
    command: 'ios.runner.snapshot',
    deviceId: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    platform: 'apple' as const,
    result: {
      nodes: [
        {
          index: 0,
          type: 'XCUIElementTypeCell',
          label: 'General',
          identifier: 'General',
          rect: { x: 16, y: 100, width: 360, height: 44 },
          enabled: true,
          hittable: true,
        },
      ],
      truncated: false,
    },
  };
}

function bottomTabsContactSnapshotNodes(): RawSnapshotNode[] {
  return [
    {
      index: 0,
      type: 'Application',
      label: 'React Navigation Example',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      enabled: true,
      hittable: true,
      depth: 0,
    },
    {
      index: 1,
      type: 'Window',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      enabled: true,
      hittable: true,
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      type: 'ScrollView',
      label: 'Contacts',
      rect: { x: 0, y: 116, width: 402, height: 675 },
      enabled: true,
      hittable: false,
      hiddenContentBelow: true,
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 3,
      type: 'StaticText',
      label: 'Marissa Castillo',
      rect: { x: 52, y: 132, width: 110, height: 17 },
      enabled: true,
      hittable: false,
      depth: 3,
      parentIndex: 2,
    },
    {
      index: 4,
      type: 'StaticText',
      label: 'Emilee Moss',
      rect: { x: 52, y: 769, width: 86, height: 17 },
      enabled: true,
      hittable: false,
      depth: 3,
      parentIndex: 2,
    },
    {
      index: 5,
      type: 'Other',
      label: 'Article, unselected',
      rect: { x: 0, y: 791, width: 402, height: 83 },
      enabled: true,
      hittable: false,
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 6,
      type: 'Button',
      label: 'Article, unselected',
      identifier: 'article',
      rect: { x: 0, y: 791, width: 101, height: 49 },
      enabled: true,
      hittable: false,
      depth: 3,
      parentIndex: 5,
    },
    {
      index: 7,
      type: 'Button',
      label: 'Chat, unselected',
      identifier: 'chat',
      rect: { x: 101, y: 791, width: 100, height: 49 },
      enabled: true,
      hittable: false,
      depth: 3,
      parentIndex: 5,
    },
    {
      index: 8,
      type: 'Button',
      label: 'Contacts, selected',
      identifier: 'contacts',
      selected: true,
      rect: { x: 201, y: 791, width: 101, height: 49 },
      enabled: true,
      hittable: false,
      depth: 3,
      parentIndex: 5,
    },
    {
      index: 9,
      type: 'Button',
      label: 'Albums, unselected',
      identifier: 'albums',
      rect: { x: 302, y: 791, width: 100, height: 49 },
      enabled: true,
      hittable: false,
      depth: 3,
      parentIndex: 5,
    },
  ];
}
