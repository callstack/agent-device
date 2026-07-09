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

// A dialog dismiss: Continue survives unchanged underneath, Cancel is the
// dialog's own button (dismissed with it) — a removals-only diff. Application
// and Window carry no `hittable` field (their normal shape) and Continue
// carries no `hittable` field either, matching #1167's post-merge benchmark
// finding: right after a dismiss animation, real buttons commonly report
// `hittable: false`/undefined, not `true`. This is the flagship regression
// case — the old `hittable === true` tail bar let Application/Window through
// (their full-screen root frame usually computes hittable) while dropping
// Continue, the only actionable target.
const MODAL_BEFORE_NODES = [
  {
    index: 0,
    type: 'Application',
    label: 'Example',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Window',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  {
    index: 2,
    parentIndex: 1,
    type: 'Button',
    label: 'Continue',
    rect: { x: 100, y: 300, width: 200, height: 44 },
  },
  {
    index: 3,
    parentIndex: 1,
    type: 'Button',
    label: 'Cancel',
    hittable: true,
    rect: { x: 100, y: 400, width: 200, height: 44 },
  },
];

const MODAL_DISMISSED_NODES = [
  {
    index: 0,
    type: 'Application',
    label: 'Example',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Window',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  {
    index: 2,
    parentIndex: 1,
    type: 'Button',
    label: 'Continue',
    rect: { x: 100, y: 300, width: 200, height: 44 },
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

function typeEntry(x: number, y: number): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.type',
    deviceId: DEVICE_ID,
    platform: 'apple',
    result: { x, y },
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
        // Coverage instrumentation can slow provider-backed daemon dispatch
        // enough that a 2s wall-clock budget expires before the two quiet
        // captures complete. The contract under test is the settled response,
        // not timeout pressure.
        timeoutMs: 10_000,
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
        tail?: Array<{ ref: string; role: string; label?: string }>;
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
      // The added line already hands back a fresh target: the diff's own refs
      // are the actionable payload, so the tail stays off.
      assert.equal(settle.tail, undefined);
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

test('Provider-backed integration modal-dismiss press --settle attaches the unchanged interactive tail', async () => {
  const runnerTranscript = createProviderTranscript([
    // snapshot -i: issues refs
    snapshotEntry(MODAL_BEFORE_NODES),
    // press label=Cancel --settle: resolution capture, tap, settle captures.
    // The dialog closes leaving Continue in place — a removals-only diff with
    // no added refs, so the tail is the only actionable-target payload.
    snapshotEntry(MODAL_BEFORE_NODES),
    tapEntry(200, 422),
    snapshotEntry(MODAL_DISMISSED_NODES),
    snapshotEntry(MODAL_DISMISSED_NODES),
    // press @e3 (the Continue ref from the tail): tap on the stored tree.
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
      assertRpcOk(snapshot);

      const press = await daemon.callCommand('press', ['label=Cancel'], {
        settle: true,
        settleQuietMs: 25,
        timeoutMs: 10_000,
      });
      const pressData = assertRpcOk(press);
      const settle = pressData.settle as {
        settled: boolean;
        refsGeneration?: number;
        diff?: {
          summary: { additions: number; removals: number; unchanged: number };
          lines: Array<{ kind: string; text: string; ref?: string }>;
        };
        tail?: Array<{ ref: string; role: string; label?: string }>;
        tailTruncated?: boolean;
      };
      assert.ok(settle, 'press --settle must return a settle observation');
      assert.equal(settle.settled, true);
      assert.deepEqual(settle.diff?.summary, { additions: 0, removals: 1, unchanged: 3 });
      assert.equal(
        settle.diff?.lines.some((line) => line.kind === 'added'),
        false,
      );
      // Application/Window survive unchanged too but are structural chrome,
      // not a next actionable target — the tail excludes them and surfaces
      // only the real button, even though it carries no `hittable: true` flag
      // (see the MODAL_BEFORE_NODES/MODAL_DISMISSED_NODES comment).
      assert.deepEqual(settle.tail, [{ ref: 'e3', role: 'button', label: 'Continue' }]);
      assert.equal(settle.tailTruncated, undefined);
      assert.equal(typeof settle.refsGeneration, 'number');

      // The tail's ref acts directly on the stored settled tree, same as an
      // added-line ref would.
      const followUp = await daemon.callCommand('press', ['@e3'], {});
      const followUpData = assertRpcOk(followUp);
      assert.equal(followUpData.warning, undefined);
      assert.equal(followUpData.x, 200);
      assert.equal(followUpData.y, 322);

      runnerTranscript.assertComplete();
    },
  );
});

// #1167 post-merge benchmark, Bug B: filling a field summons the iOS keyboard,
// and the keyboard chrome (real XCUIElementTypeButton nodes like shift/return
// — not Key nodes) used to show up as fresh added-line refs on the settled
// diff. Those refs defeated the "diff has zero added refs" tail trigger, so
// exactly the post-fill case the tail exists for never fired.
const FILL_BEFORE_NODES = [
  {
    index: 0,
    type: 'TextField',
    label: 'Search',
    hittable: true,
    rect: { x: 0, y: 0, width: 200, height: 40 },
  },
  {
    index: 1,
    type: 'Button',
    label: 'Cancel',
    hittable: true,
    rect: { x: 0, y: 50, width: 100, height: 40 },
  },
  {
    index: 2,
    type: 'Button',
    label: 'Search now',
    hittable: true,
    rect: { x: 110, y: 50, width: 100, height: 40 },
  },
];

// The field and its screen buttons are unchanged by the fill; the keyboard
// (container + chrome) is the only tree change.
const FILL_SETTLED_NODES = [
  ...FILL_BEFORE_NODES,
  {
    index: 3,
    type: 'Keyboard',
    label: 'keyboard',
    rect: { x: 0, y: 500, width: 400, height: 300 },
  },
  {
    index: 4,
    parentIndex: 3,
    type: 'Button',
    label: 'shift',
    rect: { x: 0, y: 520, width: 30, height: 40 },
  },
  {
    index: 5,
    parentIndex: 3,
    type: 'Button',
    label: 'return',
    rect: { x: 350, y: 520, width: 50, height: 40 },
  },
];

test('Provider-backed integration fill --settle summoning the keyboard still attaches the unchanged interactive tail', async () => {
  const runnerTranscript = createProviderTranscript([
    // snapshot -i: issues refs
    snapshotEntry(FILL_BEFORE_NODES),
    // fill label=Search 'hello' --settle: resolution capture, type, settle
    // captures. The keyboard appears; the field/buttons are unchanged.
    snapshotEntry(FILL_BEFORE_NODES),
    typeEntry(100, 20),
    snapshotEntry(FILL_SETTLED_NODES),
    snapshotEntry(FILL_SETTLED_NODES),
    // press @e2 (the Cancel ref from the tail): tap on the stored tree.
    tapEntry(50, 70),
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

      const fill = await daemon.callCommand('fill', ['label=Search', 'hello'], {
        settle: true,
        settleQuietMs: 25,
        timeoutMs: 10_000,
      });
      const fillData = assertRpcOk(fill);
      const settle = fillData.settle as {
        settled: boolean;
        refsGeneration?: number;
        diff?: {
          summary: { additions: number; removals: number; unchanged: number };
          lines: Array<{ kind: string; text: string; ref?: string }>;
        };
        tail?: Array<{ ref: string; role: string; label?: string }>;
        tailTruncated?: boolean;
      };
      assert.ok(settle, 'fill --settle must return a settle observation');
      assert.equal(settle.settled, true);
      // Only the keyboard container line is added; its chrome buttons
      // (shift/return) collapse into it and never reach the diff.
      assert.deepEqual(settle.diff?.summary, { additions: 1, removals: 0, unchanged: 3 });
      assert.ok(!settle.diff?.lines.some((line) => /shift|return/i.test(line.text)));
      // The keyboard container's own added ref is chrome, not a next target:
      // the trigger still fires and hands back the still-relevant controls.
      assert.deepEqual(settle.tail, [
        { ref: 'e1', role: 'text-field', label: 'Search' },
        { ref: 'e2', role: 'button', label: 'Cancel' },
        { ref: 'e3', role: 'button', label: 'Search now' },
      ]);
      assert.equal(settle.tailTruncated, undefined);
      assert.equal(typeof settle.refsGeneration, 'number');

      const followUp = await daemon.callCommand('press', ['@e2'], {});
      const followUpData = assertRpcOk(followUp);
      assert.equal(followUpData.warning, undefined);
      assert.equal(followUpData.x, 50);
      assert.equal(followUpData.y, 70);

      runnerTranscript.assertComplete();
    },
  );
});
