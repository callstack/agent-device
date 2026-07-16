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

// A UI that has gone quiet: every settle capture sees the same tree. How many
// captures the loop spends reaching that verdict is wall-clock — it polls on a
// 25ms floor and settles once two identical captures span the quiet window — so
// the count is not the contract and is never scripted here.
function quietSnapshotEntry(nodes: readonly unknown[]): ProviderScenarioProviderEntry {
  return { ...snapshotEntry(nodes), repeat: true };
}

// A UI that never goes quiet: every capture returns a fresh tree, so the loop
// can never settle no matter how many captures fit in the budget.
function changingSnapshotEntry(nodes: (label: string) => unknown[]): ProviderScenarioProviderEntry {
  let capture = 0;
  return {
    command: 'ios.runner.snapshot',
    deviceId: DEVICE_ID,
    platform: 'apple',
    repeat: true,
    result: () => {
      capture += 1;
      return { nodes: nodes(`Loading ${capture}`), truncated: false };
    },
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
    quietSnapshotEntry(SETTLED_NODES),
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
      // Snapshot-floor economy: a quiet UI settles on the two identical
      // captures the verdict needs, or three when the second lands a hair short
      // of the quiet window. Anything above that is a regression in what settle
      // spends; pinning a single number would assert the runner's speed.
      assert.ok(
        settle.captures >= 2 && settle.captures <= 3,
        `settle should cost 2-3 captures, got ${settle.captures}`,
      );
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

      // ADR 0014: the settle issued a PARTIAL frame authorizing exactly its
      // emitted ref, so the follow-up consumes it in pinned form — acting
      // directly on the stored settled tree with no fresh snapshot round trip
      // and no stale-refs warning. The plain `@e2` would require a complete
      // frame.
      const callsBeforeFollowUp = runnerTranscript.calls.length;
      const followUp = await daemon.callCommand('press', [`@e2~s${settle.refsGeneration}`], {});
      const followUpData = assertRpcOk(followUp);
      assert.equal(followUpData.warning, undefined);
      assert.equal(followUpData.x, 200);
      assert.equal(followUpData.y, 522);
      // The round trip settle exists to remove: the follow-up spends a tap and
      // nothing else. Asserted directly, since a quiet-UI entry would happily
      // serve a stray capture.
      assert.deepEqual(
        runnerTranscript.calls.slice(callsBeforeFollowUp).map((call) => call.command),
        ['ios.runner.tap'],
      );

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
    // press label=Continue --settle: resolution capture, tap, then a settle
    // stream that never repeats itself, so the loop can only ever time out.
    snapshotEntry(BEFORE_NODES),
    tapEntry(200, 322),
    changingSnapshotEntry(loadingNodes),
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
        // Budget the loop spends without settling. Wide enough that a loaded
        // runner's capture cannot outlast it — a capture that overruns the
        // budget reports the stalled hint instead of this one.
        timeoutMs: 300,
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
    quietSnapshotEntry(MODAL_DISMISSED_NODES),
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
      // added-line ref would — consumed in pinned form from the partial frame
      // (ADR 0014).
      const callsBeforeFollowUp = runnerTranscript.calls.length;
      const followUp = await daemon.callCommand('press', [`@e3~s${settle.refsGeneration}`], {});
      const followUpData = assertRpcOk(followUp);
      assert.equal(followUpData.warning, undefined);
      assert.equal(followUpData.x, 200);
      assert.equal(followUpData.y, 322);
      assert.deepEqual(
        runnerTranscript.calls.slice(callsBeforeFollowUp).map((call) => call.command),
        ['ios.runner.tap'],
      );

      runnerTranscript.assertComplete();
    },
  );
});

// #1167 post-merge benchmark, Bug B: filling a field summons the iOS keyboard,
// and the keyboard chrome (real XCUIElementTypeButton nodes like shift/return/
// Next keyboard/Dictate — not Key nodes) used to show up as fresh added-line
// refs on the settled diff. Those refs defeated the "diff has zero added refs"
// tail trigger, so exactly the post-fill case the tail exists for never fired.
//
// Both fixtures are TRIMMED REAL CAPTURES (iPhone 17 Pro simulator, iOS 26,
// July 2026, org.reactnavigation.playground rne://stack-prevent-remove Input
// screen; `snapshot -i --json` before and after `fill @e6 "hello" --settle`,
// with the 31-key block reduced to 2 representative keys and rects rounded).
// The load-bearing real-world facts they preserve:
// - The keyboard renders in its OWN window; the "Next keyboard" and "Dictate"
//   candidate-bar buttons are SIBLINGS of the [Keyboard] container's wrapper,
//   NOT its descendants (an earlier hand-built fixture modeled them one hop
//   under the container and hid the sibling-branch bug on real hardware).
// - The app's main window does not survive the interactive-only settled
//   capture; app content re-parents onto the Application node.
// - The filled field re-labels itself ("hello") and its ancestor wrappers
//   inherit that label, so the diff carries self-echo added refs.
const FILL_BEFORE_NODES = [
  {
    index: 0,
    depth: 0,
    type: 'Application',
    label: 'React Navigation Example',
    hittable: true,
    rect: { x: 0, y: 0, width: 402, height: 874 },
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'Window',
    hittable: true,
    rect: { x: 0, y: 0, width: 402, height: 874 },
  },
  {
    index: 2,
    depth: 1,
    parentIndex: 0,
    type: 'Other',
    label: 'Input',
    rect: { x: 0, y: 0, width: 402, height: 117 },
  },
  {
    index: 3,
    depth: 4,
    parentIndex: 2,
    type: 'Button',
    label: 'Home, back',
    rect: { x: 10, y: 64, width: 44, height: 44 },
  },
  {
    index: 4,
    depth: 3,
    parentIndex: 0,
    type: 'ScrollView',
    label: 'Discard and go back',
    rect: { x: 0, y: 145, width: 402, height: 667 },
  },
  {
    index: 5,
    depth: 4,
    parentIndex: 4,
    type: 'TextField',
    rect: { x: 12, y: 129, width: 377, height: 41 },
  },
  {
    index: 6,
    depth: 4,
    parentIndex: 4,
    type: 'Button',
    label: 'Discard and go back',
    rect: { x: 12, y: 182, width: 378, height: 40 },
  },
  {
    index: 7,
    depth: 4,
    parentIndex: 4,
    type: 'Button',
    label: 'Push Article',
    rect: { x: 12, y: 234, width: 378, height: 40 },
  },
];

const FILL_SETTLED_NODES = [
  {
    index: 0,
    depth: 0,
    type: 'Application',
    label: 'React Navigation Example',
    hittable: true,
    rect: { x: 0, y: 0, width: 402, height: 874 },
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'Window',
    label: 'Next keyboard',
    hittable: true,
    rect: { x: 0, y: 0, width: 402, height: 874 },
  },
  {
    index: 2,
    depth: 3,
    parentIndex: 1,
    type: 'Other',
    label: 'Next keyboard',
    hittable: true,
    rect: { x: 0, y: 566, width: 402, height: 308 },
  },
  {
    index: 3,
    depth: 4,
    parentIndex: 2,
    type: 'Other',
    label: 'Padding-Left',
    rect: { x: 0, y: 583, width: 402, height: 233 },
  },
  {
    index: 4,
    depth: 5,
    parentIndex: 3,
    type: 'Keyboard',
    label: 'Padding-Left',
    rect: { x: 0, y: 583, width: 402, height: 233 },
  },
  {
    index: 5,
    depth: 7,
    parentIndex: 4,
    type: 'Key',
    label: 'q',
    rect: { x: 5, y: 590, width: 39, height: 54 },
  },
  {
    index: 6,
    depth: 7,
    parentIndex: 4,
    type: 'Key',
    label: 'space',
    rect: { x: 103, y: 752, width: 197, height: 54 },
  },
  {
    index: 7,
    depth: 7,
    parentIndex: 4,
    type: 'Button',
    label: 'shift',
    identifier: 'shift',
    rect: { x: 5, y: 698, width: 51, height: 54 },
  },
  {
    index: 8,
    depth: 7,
    parentIndex: 4,
    type: 'Button',
    label: 'return',
    identifier: 'Return',
    rect: { x: 301, y: 752, width: 99, height: 54 },
  },
  {
    index: 9,
    depth: 5,
    parentIndex: 2,
    type: 'Button',
    label: 'Next keyboard',
    value: 'Polski',
    hittable: true,
    rect: { x: 8, y: 806, width: 68, height: 69 },
  },
  {
    index: 10,
    depth: 5,
    parentIndex: 2,
    type: 'Button',
    label: 'Dictate',
    identifier: 'dictation',
    rect: { x: 325, y: 805, width: 68, height: 69 },
  },
  {
    index: 11,
    depth: 1,
    parentIndex: 0,
    type: 'Other',
    label: 'Input',
    rect: { x: 0, y: 0, width: 402, height: 117 },
  },
  {
    index: 12,
    depth: 4,
    parentIndex: 11,
    type: 'Button',
    label: 'Home, back',
    rect: { x: 10, y: 64, width: 44, height: 44 },
  },
  {
    index: 13,
    depth: 2,
    parentIndex: 0,
    type: 'Other',
    label: 'Discard and go back',
    rect: { x: 0, y: 117, width: 402, height: 757 },
  },
  {
    index: 14,
    depth: 3,
    parentIndex: 13,
    type: 'ScrollView',
    label: 'hello',
    rect: { x: 0, y: 145, width: 402, height: 667 },
  },
  {
    index: 15,
    depth: 6,
    parentIndex: 14,
    type: 'TextField',
    label: 'hello',
    value: 'hello',
    rect: { x: 12, y: 129, width: 377, height: 41 },
  },
  {
    index: 16,
    depth: 5,
    parentIndex: 14,
    type: 'Button',
    label: 'Discard and go back',
    rect: { x: 12, y: 182, width: 378, height: 40 },
  },
  {
    index: 17,
    depth: 5,
    parentIndex: 14,
    type: 'Button',
    label: 'Push Article',
    rect: { x: 12, y: 234, width: 378, height: 40 },
  },
];

test('Provider-backed integration fill --settle summoning the keyboard still attaches the unchanged interactive tail', async () => {
  const runnerTranscript = createProviderTranscript([
    // snapshot -i: issues refs
    snapshotEntry(FILL_BEFORE_NODES),
    // fill @e6 'hello' --settle: the ref resolves on the stored tree (no
    // fresh capture), the runner types, then the settle loop captures. The
    // keyboard window appears and the field re-labels itself.
    typeEntry(201, 149),
    quietSnapshotEntry(FILL_SETTLED_NODES),
    // press @e17 (the "Discard and go back" ref from the tail): tap on the
    // stored settled tree.
    tapEntry(201, 202),
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

      const fill = await daemon.callCommand('fill', ['@e6', 'hello'], {
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
      // Added: the keyboard container signal line plus the filled field's
      // self-echo relabels (wrapper, scroll-area, text-field now "hello").
      // The keyboard window, its wrappers, keys, shift/return, and the
      // candidate-bar siblings (Next keyboard/Dictate) all collapse.
      assert.deepEqual(settle.diff?.summary, { additions: 4, removals: 3, unchanged: 5 });
      const texts = settle.diff?.lines.map((line) => line.text).join('\n') ?? '';
      assert.match(texts, /\[keyboard\]/);
      assert.ok(!/shift|return|Dictate|Next keyboard|\[key\]/.test(texts));
      // Chrome and self-echo added refs do not count as "the diff already
      // handed back a target": the trigger still fires and the tail lists
      // the screen's real controls.
      assert.deepEqual(settle.tail, [
        { ref: 'e12', role: 'other', label: 'Input' },
        { ref: 'e13', role: 'button', label: 'Home, back' },
        { ref: 'e17', role: 'button', label: 'Discard and go back' },
        { ref: 'e18', role: 'button', label: 'Push Article' },
      ]);
      assert.equal(settle.tailTruncated, undefined);
      assert.equal(typeof settle.refsGeneration, 'number');

      const callsBeforeFollowUp = runnerTranscript.calls.length;
      const followUp = await daemon.callCommand('press', [`@e17~s${settle.refsGeneration}`], {});
      const followUpData = assertRpcOk(followUp);
      assert.equal(followUpData.warning, undefined);
      assert.equal(followUpData.x, 201);
      assert.equal(followUpData.y, 202);
      assert.deepEqual(
        runnerTranscript.calls.slice(callsBeforeFollowUp).map((call) => call.command),
        ['ios.runner.tap'],
      );

      runnerTranscript.assertComplete();
    },
  );
});
