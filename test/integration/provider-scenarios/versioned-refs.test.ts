import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertRpcError, assertRpcOk } from './assertions.ts';
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
// older generation is rejected with a PRECISE hint naming both generations,
// including after a later find issued a NEWER generation (the find-blessing hole this
// feature closes). The tree output itself stays plain `e2` refs, and the
// generation values are seeded per session lifetime, so every assertion below
// is relative to the observed seed.
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

test('Provider-backed integration rejects stale pinned @refs and accepts current pins', async () => {
  const runnerTranscript = createProviderTranscript([
    // snapshot -i: issues refs at the seeded generation g1
    snapshotEntry(),
    // press label=Continue: selector resolution capture replaces the stored
    // tree (g1+1) without issuing refs
    snapshotEntry(),
    tapEntry(200, 322),
    // press @e2~s{g1}: reject the outlived ref before any runner command
    // press @e2~s{g1+1}: pinned to the CURRENT generation — clean
    tapEntry(200, 422),
    // find Cancel click: capture replaces the tree AGAIN (g1+2) and issues
    // only the found ref at the new generation
    snapshotEntry(),
    tapEntry(200, 422),
    // press @e1~s{g1+1}: a PRE-find pin — the find must not bless it (the
    // #1076 hole): reject before any runner command
    // press @e1~s{g1+2}: pinned to the post-find generation — clean
    tapEntry(200, 322),
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
      // Ref-issuing response reports the (seeded) generation ONCE; nodes stay
      // plain refs — no per-node token growth.
      assert.equal(typeof snapshotData.refsGeneration, 'number');
      const g1 = snapshotData.refsGeneration as number;
      const nodes = snapshotData.nodes as Array<{ ref?: string }>;
      assert.ok(nodes.length > 0);
      assert.ok(nodes.every((node) => node.ref === undefined || !node.ref.includes('~')));

      const selectorPress = await daemon.callCommand('press', ['label=Continue'], {});
      const selectorData = assertRpcOk(selectorPress);
      assert.equal(selectorData.warning, undefined);

      const pinnedStale = await daemon.callCommand('press', [`@e2~s${g1}`], {});
      const pinnedStaleData = assertRpcError(
        pinnedStale,
        'COMMAND_FAILED',
        /Ref @e2 not found or has no bounds/,
      );
      assert.equal(
        pinnedStaleData.hint,
        `Ref @e2 was minted from snapshot s${g1} but the session tree is now s${g1 + 1} — re-run snapshot -i.`,
      );

      const pinnedCurrent = await daemon.callCommand('press', [`@e2~s${g1 + 1}`], {});
      const pinnedCurrentData = assertRpcOk(pinnedCurrent);
      assert.equal(pinnedCurrentData.warning, undefined);

      // The blessing flow: find replaces the tree and issues its ref at the
      // NEW generation…
      const find = await daemon.callCommand('find', ['Cancel', 'click'], {});
      const findData = assertRpcOk(find);
      assert.equal(findData.refsGeneration, g1 + 2);

      // …but a ref pinned BEFORE the find is still rejected precisely — the
      // find response must not silently re-bless it.
      const preFindPin = await daemon.callCommand('press', [`@e1~s${g1 + 1}`], {});
      const preFindPinData = assertRpcError(
        preFindPin,
        'COMMAND_FAILED',
        /Ref @e1 not found or has no bounds/,
      );
      assert.equal(
        preFindPinData.hint,
        `Ref @e1 was minted from snapshot s${g1 + 1} but the session tree is now s${g1 + 2} — re-run snapshot -i.`,
      );

      const postFindPin = await daemon.callCommand('press', [`@e1~s${g1 + 2}`], {});
      const postFindPinData = assertRpcOk(postFindPin);
      assert.equal(postFindPinData.warning, undefined);

      runnerTranscript.assertComplete();
    },
  );
});
