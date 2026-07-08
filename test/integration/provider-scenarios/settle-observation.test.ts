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

// #1101 --settle end-to-end: press executes the tap, the settle loop captures
// until the tree goes quiet, and the SAME response carries the settled diff
// (with fresh refs + refsGeneration) — the follow-up observation round trip
// and its stale-ref hazard both disappear.

const BEFORE_NODES = [
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

const SETTLED_NODES = [
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
    label: 'Done',
    hittable: true,
    rect: { x: 100, y: 500, width: 200, height: 44 },
  },
];

function snapshotEntry(nodes: readonly unknown[]): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.snapshot',
    deviceId: DEVICE_ID,
    platform: 'apple',
    result: { nodes, truncated: false },
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

test('Provider-backed integration press --settle returns the settled diff and fresh refs', async () => {
  const runnerTranscript = createProviderTranscript([
    // snapshot -i: issues refs
    snapshotEntry(BEFORE_NODES),
    // press label=Continue --settle: resolution capture, tap, settle captures
    snapshotEntry(BEFORE_NODES),
    tapEntry(200, 322),
    snapshotEntry(SETTLED_NODES),
    snapshotEntry(SETTLED_NODES),
    // press @e2 (the Done ref from the settled diff): tap on the stored tree
    tapEntry(200, 522),
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

      const press = await daemon.callCommand('press', ['label=Continue'], {
        settle: true,
        settleQuietMs: 25,
        timeoutMs: 2_000,
      });
      const pressData = assertRpcOk(press);
      const settle = pressData.settle as {
        settled: boolean;
        captures: number;
        refsGeneration?: number;
        diff?: {
          summary: { additions: number; removals: number; unchanged: number };
          lines: Array<{ kind: string; text: string; ref?: string }>;
        };
        hint?: string;
      };
      assert.ok(settle, 'press --settle must return a settle observation');
      assert.equal(settle.settled, true);
      assert.equal(settle.captures, 2);
      assert.equal(typeof settle.refsGeneration, 'number');
      assert.deepEqual(settle.diff?.summary, { additions: 1, removals: 2, unchanged: 1 });
      const added = settle.diff?.lines.find((line) => line.kind === 'added');
      assert.match(added?.text ?? '', /Done/);
      assert.equal(added?.ref, 'e2');
      // The settled tree is never serialized into the response.
      assert.equal(pressData.nodes, undefined);

      // The diff's ref acts directly on the stored settled tree — no fresh
      // snapshot round trip and no stale-refs warning.
      const followUp = await daemon.callCommand('press', ['@e2'], {});
      const followUpData = assertRpcOk(followUp);
      assert.equal(followUpData.warning, undefined);
      assert.equal(followUpData.x, 200);
      assert.equal(followUpData.y, 522);

      runnerTranscript.assertComplete();
    },
  );
});

test('Provider-backed integration never-settled press --settle does not issue diff refs', async () => {
  const loadingNodes = (label: string) => [
    {
      index: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'StaticText',
      label,
      hittable: true,
      rect: { x: 100, y: 300, width: 200, height: 44 },
    },
  ];
  const runnerTranscript = createProviderTranscript([
    // press label=Continue --settle: resolution capture, tap, then a changing
    // settle stream. The loop times out; the final capture is not actionable.
    snapshotEntry(BEFORE_NODES),
    tapEntry(200, 322),
    snapshotEntry(loadingNodes('Loading 1')),
    snapshotEntry(loadingNodes('Loading 2')),
    snapshotEntry(SETTLED_NODES),
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

      const press = await daemon.callCommand('press', ['label=Continue'], {
        settle: true,
        settleQuietMs: 25,
        timeoutMs: 60,
      });
      const pressData = assertRpcOk(press);
      const settle = pressData.settle as {
        settled: boolean;
        refsGeneration?: number;
        diff?: {
          summary: { additions: number; removals: number; unchanged: number };
          lines: Array<{ kind: string; text: string; ref?: string }>;
        };
        hint?: string;
      };
      assert.equal(settle.settled, false);
      assert.equal(settle.refsGeneration, undefined);
      assert.match(settle.hint ?? '', /kept changing/);
      assert.equal(settle.diff, undefined);

      runnerTranscript.assertComplete();
    },
  );
});
