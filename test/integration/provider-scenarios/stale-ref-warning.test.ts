import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlListDevicesHandler,
} from './providers.ts';
import { createProviderTranscript, type ProviderScenarioProviderEntry } from './transcript.ts';

const APP = 'com.example.app';
const DEVICE_ID = PROVIDER_SCENARIO_IOS_SIMULATOR.id;

// #1076: refs are positional indexes into the latest stored session tree. A
// selector press recaptures that tree without handing the new refs to the
// client, so a follow-up @ref command gets an honest stale-refs warning until
// a snapshot response re-issues refs.
const NODES = [
  {
    index: 0,
    type: 'Application',
    label: 'Example',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    hittable: true,
    rect: { x: 100, y: 300, width: 200, height: 44 },
  },
  {
    index: 2,
    parentIndex: 0,
    type: 'Button',
    label: 'Cancel',
    hittable: true,
    rect: { x: 100, y: 400, width: 200, height: 44 },
  },
];

function snapshotEntry(): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.snapshot',
    deviceId: DEVICE_ID,
    platform: 'apple',
    result: { nodes: NODES, truncated: false },
  };
}

function tapEntry(x: number, y: number): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.tap',
    deviceId: DEVICE_ID,
    platform: 'apple',
    result: { x, y },
  };
}

test('Provider-backed integration @refs warn after a selector press replaces the tree', async () => {
  const runnerTranscript = createProviderTranscript([
    // snapshot -i: issues refs to the client
    snapshotEntry(),
    // press label=Continue: selector resolution capture replaces the stored tree
    snapshotEntry(),
    tapEntry(200, 322),
    // press @e2 while stale: executes, warns
    tapEntry(200, 422),
    // snapshot: re-issues refs
    snapshotEntry(),
    // press @e2 after refresh: no warning
    tapEntry(200, 422),
  ]);
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(
    runnerTranscript,
    'ios.runner',
  );
  const appleTool = createRecordingAppleToolProvider({
    simctl: simctlListDevicesHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
      { name: PROVIDER_SCENARIO_IOS_SIMULATOR.name, udid: DEVICE_ID },
    ]),
  });

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        appleRunnerProvider: () => appleRunnerProvider,
        appleToolProvider: () => appleTool.provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
      }),
    async (daemon) => {
      const open = await daemon.callCommand('open', [APP], {
        platform: 'ios',
        udid: DEVICE_ID,
      });
      assertRpcOk(open);

      const snapshot = await daemon.callCommand('snapshot', [], {
        snapshotInteractiveOnly: true,
      });
      assertRpcOk(snapshot);

      const selectorPress = await daemon.callCommand('press', ['label=Continue'], {});
      const selectorData = assertRpcOk(selectorPress);
      assert.equal(selectorData.warning, undefined);

      const stalePress = await daemon.callCommand('press', ['@e2'], {});
      const staleData = assertRpcOk(stalePress);
      assert.equal(typeof staleData.warning, 'string');
      assert.match(String(staleData.warning), /snapshot changed since your refs were issued/);
      assert.match(String(staleData.warning), /Re-run snapshot -i/);

      const refresh = await daemon.callCommand('snapshot', [], {
        snapshotInteractiveOnly: true,
      });
      assertRpcOk(refresh);

      const freshPress = await daemon.callCommand('press', ['@e2'], {});
      const freshData = assertRpcOk(freshPress);
      assert.equal(freshData.warning, undefined);

      runnerTranscript.assertComplete();
    },
  );
});
