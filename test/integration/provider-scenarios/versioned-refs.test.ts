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
    // snapshot -i: issues the complete frame at the seeded generation g1
    snapshotEntry(),
    // press @e2~s{g1}: pinned to the CURRENT frame — admitted, taps Cancel,
    // and crosses the seam so the frame expires
    tapEntry(200, 422),
    // snapshot -i: re-issues a fresh complete frame at g2 (= g1+1)
    snapshotEntry(),
    // press @e2~s{g1}: an outlived pin against the active g2 frame — rejected
    // with a precise generation mismatch before any runner command
    // press @e2~s{g2}: pinned to the current frame — admitted, taps Cancel
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
      // Ref-issuing response reports the (seeded) generation ONCE; nodes stay
      // plain refs — no per-node token growth.
      assert.equal(typeof snapshotData.refsGeneration, 'number');
      const g1 = snapshotData.refsGeneration as number;
      const nodes = snapshotData.nodes as Array<{ ref?: string }>;
      assert.ok(nodes.length > 0);
      assert.ok(nodes.every((node) => node.ref === undefined || !node.ref.includes('~')));

      // A pin to the current frame is admitted; the tap crosses the seam.
      const pinnedCurrent = await daemon.callCommand('press', [`@e2~s${g1}`], {});
      assert.equal(assertRpcOk(pinnedCurrent).warning, undefined);

      // ADR 0014: the mutation expired the frame, so a fresh observation is
      // required before another ref mutation.
      const refresh = await daemon.callCommand('snapshot', [], {
        snapshotInteractiveOnly: true,
      });
      const g2 = assertRpcOk(refresh).refsGeneration as number;
      assert.equal(g2, g1 + 1);

      // The outlived pin is rejected precisely against the active g2 frame.
      const pinnedStale = await daemon.callCommand('press', [`@e2~s${g1}`], {});
      const pinnedStaleData = assertRpcError(
        pinnedStale,
        'COMMAND_FAILED',
        /Ref @e2 was minted from a superseded snapshot generation/,
      );
      const pinnedStaleDetails = pinnedStaleData.details as Record<string, unknown>;
      assert.equal(pinnedStaleDetails.reason, 'ref_generation_mismatch');
      assert.equal(pinnedStaleDetails.mintedGeneration, g1);
      assert.equal(pinnedStaleDetails.currentGeneration, g2);
      assert.equal(
        pinnedStaleData.hint,
        `Ref @e2 was minted from snapshot s${g1} but the session tree is now s${g2} — re-run snapshot -i.`,
      );

      // A pin to the current generation is admitted.
      const pinnedFresh = await daemon.callCommand('press', [`@e2~s${g2}`], {});
      assert.equal(assertRpcOk(pinnedFresh).warning, undefined);

      runnerTranscript.assertComplete();
    },
  );
});
