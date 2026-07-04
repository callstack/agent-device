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

// #1076 versioned refs: ref-issuing responses carry the session tree's
// generation once (`refsGeneration`); a consumer may pin refs as `@e2~s<n>`.
// A pinned ref matching the stored generation is clean; a pinned ref from an
// older generation gets a PRECISE warning naming both generations. The tree
// output itself stays plain `e2` refs.
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

test('Provider-backed integration pinned @refs get precise generation warnings', async () => {
  const runnerTranscript = createProviderTranscript([
    // snapshot -i: issues refs at generation 1
    snapshotEntry(),
    // press label=Continue: selector resolution capture replaces the stored
    // tree (generation 2) without issuing refs
    snapshotEntry(),
    tapEntry(200, 322),
    // press @e2~s1: pinned to the outlived generation — executes, warns precisely
    tapEntry(200, 422),
    // press @e2~s2: pinned to the CURRENT generation — clean
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
      const snapshotData = assertRpcOk(snapshot);
      // Ref-issuing response reports the generation ONCE; nodes stay plain refs.
      assert.equal(snapshotData.refsGeneration, 1);
      const nodes = snapshotData.nodes as Array<{ ref?: string }>;
      assert.ok(nodes.every((node) => node.ref === undefined || !node.ref.includes('~')));

      const selectorPress = await daemon.callCommand('press', ['label=Continue'], {});
      const selectorData = assertRpcOk(selectorPress);
      assert.equal(selectorData.warning, undefined);

      const pinnedStale = await daemon.callCommand('press', ['@e2~s1'], {});
      const pinnedStaleData = assertRpcOk(pinnedStale);
      assert.equal(
        pinnedStaleData.warning,
        'Ref @e2 was minted from snapshot s1 but the session tree is now s2 — re-run snapshot -i.',
      );

      const pinnedCurrent = await daemon.callCommand('press', ['@e2~s2'], {});
      const pinnedCurrentData = assertRpcOk(pinnedCurrent);
      assert.equal(pinnedCurrentData.warning, undefined);

      runnerTranscript.assertComplete();
    },
  );
});
