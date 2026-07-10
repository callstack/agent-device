import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotResult } from '../../../backend.ts';
import type { SnapshotState } from '../../../kernel/snapshot.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import { ref, selector } from './selector-read.ts';
import { buildSettleTailEntries, NEVER_SETTLED_HINT } from './settle.ts';

// #1101 --settle: quiet-window settle loop composition on the interaction
// commands. Budgets are injected (fake clock) — no real waiting.

function createFakeClock(stepMs = 300): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
} {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms > 0 ? ms : stepMs;
    },
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

function buttonSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
  ]);
}

// Five nodes so a settled capture clears the tiny-tree readiness heuristic.
function welcomeSnapshot(): SnapshotState {
  return makeSnapshotState(
    ['Welcome!', 'Next', 'Back', 'Home', 'Menu'].map((label, index) => ({
      index,
      depth: index === 0 ? 0 : 1,
      ...(index === 0 ? {} : { parentIndex: 0 }),
      type: index === 0 ? 'StaticText' : 'Button',
      label,
      rect: { x: 10, y: 20 + index * 60, width: 100, height: 40 },
      hittable: true,
    })),
  );
}

function createSettleDevice(params: {
  stored: SnapshotState;
  captureSnapshot: () => Promise<BackendSnapshotResult> | BackendSnapshotResult;
  tap?: () => Promise<Record<string, unknown>>;
  clock?: ReturnType<typeof createFakeClock>;
  appBundleId?: string;
}): ReturnType<typeof createAgentDevice> {
  return createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => await params.captureSnapshot(),
      tap: async () => (params.tap ? await params.tap() : { ok: true }),
      fill: async () => ({ ok: true }),
      longPress: async () => ({ ok: true }),
      typeText: async () => {},
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      {
        name: 'default',
        snapshot: params.stored,
        ...(params.appBundleId ? { appBundleId: params.appBundleId } : {}),
      },
    ]),
    policy: localCommandPolicy(),
    clock: params.clock ?? createFakeClock(),
  });
}

test('press --settle returns the settled diff and stores the settled tree', async () => {
  const before = buttonSnapshot();
  const after = welcomeSnapshot();
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      // Capture 1 = selector resolution (baseline). Captures 2+ = settle loop.
      return { snapshot: captures === 1 ? before : after };
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: {},
  });

  assert.equal(result.kind, 'selector');
  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, true);
  assert.equal(settle.quietMs, 500);
  assert.equal(settle.timeoutMs, 10_000);
  assert.ok(settle.captures >= 2);
  assert.equal(settle.hint, undefined);
  assert.deepEqual(settle.diff?.summary, { additions: 5, removals: 1, unchanged: 0 });
  const addedRefs = settle.diff?.lines
    .filter((line) => line.kind === 'added')
    .map((line) => line.ref);
  assert.deepEqual(addedRefs, ['e1', 'e2', 'e3', 'e4', 'e5']);
  const removed = settle.diff?.lines.find((line) => line.kind === 'removed');
  assert.match(removed?.text ?? '', /Continue/);
  assert.equal(removed?.ref, undefined);

  // The settled tree became the session snapshot: the diff's refs resolve.
  const stored = (await device.sessions.get('default')) as { snapshot?: SnapshotState };
  assert.equal(stored.snapshot?.nodes[0]?.label, 'Welcome!');
  // Added lines already hand back a fresh target: the tail would be pure cost.
  assert.equal(settle.tail, undefined);
  assert.equal(settle.tailTruncated, undefined);
});

test('never-settling content returns settled: false without an actionable diff', async () => {
  const before = buttonSnapshot();
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      if (captures === 1) return { snapshot: before };
      // Ticker: every capture differs.
      return {
        snapshot: makeSnapshotState([
          {
            index: 0,
            depth: 0,
            type: 'StaticText',
            label: `Tick ${captures}`,
            rect: { x: 10, y: 20, width: 100, height: 40 },
            hittable: true,
          },
        ]),
      };
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: { quietMs: 500, timeoutMs: 2_000 },
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, false);
  assert.equal(settle.hint, NEVER_SETTLED_HINT);
  assert.equal(settle.diff, undefined);
});

test('private-ax recovery resets the settle budget once', async () => {
  const before = buttonSnapshot();
  const recoveredAfter = welcomeSnapshot();
  recoveredAfter.snapshotQuality = {
    state: 'recovered',
    backend: 'private-ax',
    reasonCode: 'budget',
    reason: 'tree backend was too slow',
  };
  let captures = 0;
  const clock = createFakeClock();
  const device = createSettleDevice({
    stored: before,
    clock,
    captureSnapshot: () => {
      captures += 1;
      if (captures === 1) return { snapshot: before };
      if (captures === 2) {
        // This recovery arrives close enough to the original 1000ms timeout
        // that the loop would time out before the 500ms quiet window without
        // the one-shot private-AX budget reset.
        clock.advance(900);
      }
      return { snapshot: recoveredAfter };
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: { quietMs: 500, timeoutMs: 1_000 },
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, true);
  assert.ok(settle.diff);
  assert.equal(captures, 4);
});

test('a broken settle capture never fails the action', async () => {
  const before = buttonSnapshot();
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      if (captures === 1) return { snapshot: before };
      throw new Error('AX bridge crashed');
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: {},
  });

  // The press itself succeeded; the observation reports its own failure.
  assert.equal(result.kind, 'selector');
  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, false);
  assert.equal(settle.diff, undefined);
  assert.match(settle.hint ?? '', /Settle observation unavailable \(AX bridge crashed\)/);
});

test('--settle --verify shares the settle captures for evidence (zero extra captures)', async () => {
  const before = buttonSnapshot();
  const after = welcomeSnapshot();
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : after };
    },
  });

  const result = await device.interactions.click(selector('label=Continue'), {
    session: 'default',
    verify: true,
    settle: {},
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, true);
  assert.ok(result.evidence);
  assert.equal(result.evidence?.changedFromBefore, true);
  assert.equal(result.evidence?.nodeCount, 5);
  // 1 resolution capture + the settle loop's captures — verify added none.
  assert.equal(captures, 1 + settle.captures);
});

test('longpress --settle rides the same observation path', async () => {
  const before = buttonSnapshot();
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : welcomeSnapshot() };
    },
  });

  const result = await device.interactions.longPress(ref('@e1'), {
    session: 'default',
    durationMs: 400,
    settle: { quietMs: 100, timeoutMs: 1_000 },
  });

  assert.equal(result.kind, 'ref');
  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, true);
  assert.equal(settle.quietMs, 100);
  assert.equal(settle.timeoutMs, 1_000);
  assert.ok(settle.diff);
});

test('the settled diff line list is bounded with a truncation marker', async () => {
  const before = buttonSnapshot();
  const bigTree = makeSnapshotState(
    Array.from({ length: 120 }, (_, index) => ({
      index,
      depth: 0,
      type: 'StaticText',
      label: `Row ${index}`,
      rect: { x: 0, y: index * 20, width: 100, height: 20 },
      hittable: true,
    })),
  );
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : bigTree };
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: {},
  });

  const diff = result.settle?.diff;
  assert.ok(diff);
  assert.equal(diff.summary.additions, 120);
  assert.equal(diff.lines.length, 80);
  assert.equal(diff.truncated, true);
});

// Keyboard chrome fixtures mirror the LIVE capture shape (iPhone 17 Pro sim,
// iOS 26, July 2026, React Navigation playground): the keyboard renders in
// its own dedicated window; the [Keyboard] container (keys + shift/Emoji/
// return buttons) and the "Next keyboard"/"Dictate" candidate-bar buttons are
// SIBLING subtrees under that window — the candidate-bar buttons are NOT
// descendants of the container, which is exactly what an earlier hand-built
// fixture got wrong (a container-descendant walk alone misses them).
function keyboardWindowNodes(startIndex: number, parentIndex?: number) {
  const kb = startIndex;
  return [
    {
      index: kb,
      depth: 1,
      ...(parentIndex !== undefined ? { parentIndex } : {}),
      type: 'Window',
      label: 'Next keyboard',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: kb + 1,
      depth: 3,
      parentIndex: kb,
      type: 'Other',
      label: 'Next keyboard',
      rect: { x: 0, y: 566, width: 402, height: 308 },
      hittable: true,
    },
    {
      index: kb + 2,
      depth: 4,
      parentIndex: kb + 1,
      type: 'Other',
      label: 'Padding-Left',
      rect: { x: 0, y: 583, width: 402, height: 233 },
    },
    {
      index: kb + 3,
      depth: 5,
      parentIndex: kb + 2,
      type: 'Keyboard',
      label: 'Padding-Left',
      rect: { x: 0, y: 583, width: 402, height: 233 },
    },
    ...Array.from({ length: 26 }, (_, key) => ({
      index: kb + 4 + key,
      depth: 7,
      parentIndex: kb + 3,
      type: 'Key',
      label: String.fromCharCode(97 + key),
      rect: { x: (key % 10) * 40, y: 590 + Math.floor(key / 10) * 54, width: 39, height: 54 },
    })),
    ...['shift', 'Emoji', 'return'].map((label, extra) => ({
      index: kb + 30 + extra,
      depth: 7,
      parentIndex: kb + 3,
      type: 'Button',
      label,
      rect: { x: 5 + extra * 50, y: 752, width: 49, height: 54 },
    })),
    // Candidate-bar chrome: siblings of the [Keyboard] container's wrapper,
    // not descendants of the container itself.
    {
      index: kb + 33,
      depth: 5,
      parentIndex: kb + 1,
      type: 'Button',
      label: 'Next keyboard',
      rect: { x: 8, y: 806, width: 68, height: 69 },
      hittable: true,
    },
    {
      index: kb + 34,
      depth: 5,
      parentIndex: kb + 1,
      type: 'Button',
      label: 'Dictate',
      rect: { x: 325, y: 805, width: 68, height: 69 },
    },
  ];
}

test('keyboard keys, chrome buttons, and candidate-bar siblings never spend the settled diff budget', async () => {
  const before = buttonSnapshot();
  // A fill-style settled tree: the summoned keyboard window plus the content
  // change the agent actually cares about.
  const keyboardTree = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Example',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    ...keyboardWindowNodes(1, 0),
    {
      index: 36,
      depth: 1,
      parentIndex: 0,
      type: 'StaticText',
      label: 'Results for alpenglow',
      rect: { x: 0, y: 0, width: 200, height: 20 },
      hittable: true,
    },
    ...['Next', 'Back', 'Home'].map((label, extra) => ({
      index: extra + 37,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label,
      rect: { x: 0, y: 240 + extra * 40, width: 100, height: 40 },
      hittable: true,
    })),
  ]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : keyboardTree };
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: {},
  });

  const diff = result.settle?.diff;
  assert.ok(diff);
  const texts = diff.lines.map((line) => line.text).join('\n');
  assert.match(texts, /Results for alpenglow/);
  assert.match(texts, /\[keyboard\]/);
  // The container line survives as the keyboard signal; keys, chrome buttons
  // under the container, the candidate-bar siblings (Next keyboard/Dictate),
  // and the keyboard window's own wrappers all collapse.
  assert.ok(!diff.lines.some((line) => /\[key\]/.test(line.text)));
  assert.ok(!diff.lines.some((line) => /shift|Emoji|return|Dictate|Next keyboard/.test(line.text)));
  // application + keyboard container + StaticText + 3 screen buttons.
  assert.equal(diff.summary.additions, 6);
});

test('keyboard-only changes (window + container + chrome) do not suppress the settle tail trigger', async () => {
  // The field and its screen buttons are unchanged by the fill itself; the
  // keyboard summoning is the only tree change. Before #1167's fix, the
  // chrome buttons' fresh added-line refs (or, after the diff-only fix, the
  // container's own added ref) would read as "the diff already handed back a
  // target" and suppress the tail — leaving the still-relevant screen
  // buttons invisible.
  const controls = [
    {
      index: 0,
      depth: 0,
      type: 'TextField',
      label: 'Search',
      rect: { x: 0, y: 0, width: 200, height: 40 },
      hittable: true,
    },
    {
      index: 1,
      depth: 0,
      type: 'Button',
      label: 'Cancel',
      rect: { x: 0, y: 50, width: 100, height: 40 },
      hittable: true,
    },
    {
      index: 2,
      depth: 0,
      type: 'Button',
      label: 'Search now',
      rect: { x: 110, y: 50, width: 100, height: 40 },
      hittable: true,
    },
  ];
  const before = makeSnapshotState(controls);
  const settledTree = makeSnapshotState([...controls, ...keyboardWindowNodes(3)]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : settledTree };
    },
  });

  const result = await device.interactions.fill(selector('label=Search'), 'hello', {
    session: 'default',
    settle: {},
  });

  const settle = result.settle;
  assert.ok(settle);
  // Only the keyboard container line is added; the window, its wrappers, the
  // chrome buttons, and the candidate-bar siblings all collapse.
  assert.equal(settle.diff?.summary.additions, 1);
  assert.ok(
    !settle.diff?.lines.some((line) => /shift|return|Dictate|Next keyboard/i.test(line.text)),
  );
  assert.ok(settle.tail, 'keyboard-only additions must not suppress the tail');
  assert.deepEqual(
    settle.tail?.map((entry) => entry.label),
    ['Search', 'Cancel', 'Search now'],
  );
});

test('a filled field relabeling itself (self-echo added refs) does not suppress the settle tail', async () => {
  // Live-verified shape: filling a field re-labels the field line with its
  // new value (and ancestor wrappers inherit it), so the diff carries added
  // refs even though nothing NEW appeared on screen. Those self-echo refs
  // (settled node rect contains the action point) must not suppress the
  // tail — the next targets after a fill are the screen's unchanged controls.
  const before = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'TextField',
      rect: { x: 12, y: 129, width: 377, height: 41 },
      hittable: true,
    },
    {
      index: 1,
      depth: 0,
      type: 'Button',
      label: 'Submit',
      rect: { x: 12, y: 182, width: 378, height: 40 },
      hittable: true,
    },
  ]);
  const settledTree = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'TextField',
      label: 'hello',
      value: 'hello',
      rect: { x: 12, y: 129, width: 377, height: 41 },
      hittable: true,
    },
    {
      index: 1,
      depth: 0,
      type: 'Button',
      label: 'Submit',
      rect: { x: 12, y: 182, width: 378, height: 40 },
      hittable: true,
    },
  ]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : settledTree };
    },
  });

  const result = await device.interactions.fill(ref('@e1'), 'hello', {
    session: 'default',
    settle: {},
  });

  const settle = result.settle;
  assert.ok(settle);
  // The relabeled field IS an added line (with a ref) in the diff...
  const added = settle.diff?.lines.filter((line) => line.kind === 'added') ?? [];
  assert.equal(added.length, 1);
  assert.match(added[0]?.text ?? '', /hello/);
  assert.ok(added[0]?.ref);
  // ...but it re-describes the acted-on element, so the tail still fires
  // with the actual next target.
  assert.deepEqual(settle.tail, [{ ref: 'e2', role: 'button', label: 'Submit' }]);
});

test('a keyboard window hosting an app composer field is never window-classified as chrome', async () => {
  // iOS hosts inputAccessoryView content (e.g. a messaging composer) in the
  // keyboard window. The conservative guard keeps such windows out of the
  // whole-window chrome rule: the composer field/send button must stay
  // visible even though candidate-bar chrome then leaks through.
  const before = buttonSnapshot();
  const settledTree = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Chat',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: true,
    },
    // inputAccessoryView composer: an editable field OUTSIDE the [Keyboard]
    // container but INSIDE the keyboard window.
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'TextField',
      label: 'Message',
      rect: { x: 0, y: 500, width: 320, height: 44 },
      hittable: true,
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Send',
      rect: { x: 330, y: 500, width: 60, height: 44 },
      hittable: true,
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Keyboard',
      label: 'keyboard',
      rect: { x: 0, y: 566, width: 402, height: 308 },
    },
    {
      index: 5,
      depth: 3,
      parentIndex: 4,
      type: 'Key',
      label: 'q',
      rect: { x: 5, y: 590, width: 39, height: 54 },
    },
    {
      index: 6,
      depth: 3,
      parentIndex: 4,
      type: 'Button',
      label: 'shift',
      rect: { x: 5, y: 698, width: 51, height: 54 },
    },
  ]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : settledTree };
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: {},
  });

  const diff = result.settle?.diff;
  assert.ok(diff);
  const texts = diff.lines.map((line) => line.text).join('\n');
  // Composer content survives; container-descendant chrome still collapses.
  assert.match(texts, /Message/);
  assert.match(texts, /Send/);
  assert.match(texts, /\[keyboard\]/);
  assert.ok(!diff.lines.some((line) => /\[key\]|shift/.test(line.text)));
});

// #1198: Android settle-diff scope. Shapes below are trimmed from a real
// `snapshot --raw --json` capture against the react-navigation playground on
// an Android emulator (July 2026, stock-UIAutomator fallback path) — status
// bar and IME each render as their own whole top-level root, one node per
// window, `bundleId` carrying the OWNING package on every node.
const ANDROID_APP_BUNDLE_ID = 'org.reactnavigation.playground';
const ANDROID_SYSTEM_UI_BUNDLE_ID = 'com.android.systemui';
const ANDROID_IME_BUNDLE_ID = 'com.google.android.inputmethod.latin';

function androidStatusBarNodes(startIndex: number, clockLabel = '12:23') {
  const root = startIndex;
  return [
    {
      index: root,
      depth: 0,
      type: 'android.widget.FrameLayout',
      bundleId: ANDROID_SYSTEM_UI_BUNDLE_ID,
      rect: { x: 0, y: 0, width: 1344, height: 159 },
    },
    {
      // The marker every real status-bar capture carries; the window-run
      // drops as a whole because this member matches the status_bar* prefix.
      index: root + 1,
      depth: 1,
      parentIndex: root,
      type: 'android.widget.FrameLayout',
      identifier: 'com.android.systemui:id/status_bar_container',
      bundleId: ANDROID_SYSTEM_UI_BUNDLE_ID,
      rect: { x: 0, y: 0, width: 1344, height: 159 },
    },
    {
      index: root + 2,
      depth: 10,
      parentIndex: root + 1,
      type: 'android.widget.TextView',
      identifier: 'com.android.systemui:id/clock',
      label: clockLabel,
      bundleId: ANDROID_SYSTEM_UI_BUNDLE_ID,
      rect: { x: 40, y: 40, width: 80, height: 40 },
    },
    {
      index: root + 3,
      depth: 11,
      parentIndex: root + 1,
      type: 'android.widget.FrameLayout',
      identifier: 'com.android.systemui:id/mobile_combo',
      label: 'T-Mobile, one bar.',
      bundleId: ANDROID_SYSTEM_UI_BUNDLE_ID,
      rect: { x: 900, y: 40, width: 60, height: 40 },
    },
    {
      index: root + 4,
      depth: 11,
      parentIndex: root + 1,
      type: 'android.view.View',
      label: 'Battery 100 percent.',
      bundleId: ANDROID_SYSTEM_UI_BUNDLE_ID,
      rect: { x: 1200, y: 40, width: 60, height: 40 },
    },
  ];
}

// Real systemui VolumeDialog window captured live alongside the status bar
// (volume keyevent held open + `snapshot --raw --json`, android-helper
// multi-window backend): same package as the status bar but only
// volume_dialog* ids — no status/nav-bar marker in the run, so it must
// survive with actionable refs.
function androidVolumeDialogNodes(startIndex: number) {
  const root = startIndex;
  return [
    {
      index: root,
      depth: 0,
      type: 'android.widget.FrameLayout',
      bundleId: ANDROID_SYSTEM_UI_BUNDLE_ID,
      rect: { x: 816, y: 159, width: 528, height: 2833 },
    },
    {
      index: root + 1,
      depth: 2,
      parentIndex: root,
      type: 'android.widget.FrameLayout',
      identifier: 'com.android.systemui:id/volume_dialog',
      bundleId: ANDROID_SYSTEM_UI_BUNDLE_ID,
      rect: { x: 1100, y: 1000, width: 220, height: 1100 },
    },
    {
      index: root + 2,
      depth: 3,
      parentIndex: root + 1,
      type: 'android.widget.ImageButton',
      identifier: 'com.android.systemui:id/volume_dialog_settings',
      label: 'Sound settings',
      bundleId: ANDROID_SYSTEM_UI_BUNDLE_ID,
      rect: { x: 1140, y: 1950, width: 140, height: 140 },
      hittable: true,
    },
    {
      index: root + 3,
      depth: 3,
      parentIndex: root + 1,
      type: 'android.widget.SeekBar',
      identifier: 'com.android.systemui:id/volume_dialog_slider',
      label: 'Media',
      bundleId: ANDROID_SYSTEM_UI_BUNDLE_ID,
      rect: { x: 1140, y: 1100, width: 140, height: 800 },
      hittable: true,
    },
    {
      index: root + 4,
      depth: 3,
      parentIndex: root + 1,
      type: 'android.widget.ImageButton',
      label: 'Ring, tap to change ringer mode',
      bundleId: ANDROID_SYSTEM_UI_BUNDLE_ID,
      rect: { x: 1140, y: 950, width: 140, height: 140 },
      hittable: true,
    },
  ];
}

function androidImeNodes(startIndex: number) {
  const root = startIndex;
  return [
    {
      index: root,
      depth: 0,
      type: 'android.widget.FrameLayout',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 0, y: 159, width: 1344, height: 2833 },
      hittable: true,
    },
    {
      index: root + 1,
      depth: 8,
      parentIndex: root,
      type: 'android.speech.SpeechRecognizer.VoiceDictationButton',
      label: 'Use voice typing',
      identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 20, y: 2600, width: 100, height: 100 },
      hittable: true,
    },
    {
      index: root + 2,
      depth: 8,
      parentIndex: root,
      type: 'android.widget.FrameLayout',
      label: 'Delete',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 1100, y: 2350, width: 130, height: 130 },
      hittable: true,
    },
    {
      index: root + 3,
      depth: 8,
      parentIndex: root,
      type: 'android.widget.FrameLayout',
      label: 'Done',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 1100, y: 2600, width: 130, height: 130 },
      hittable: true,
    },
    {
      index: root + 4,
      depth: 8,
      parentIndex: root,
      type: 'android.widget.FrameLayout',
      label: 'Show emoji keyboard',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 20, y: 2850, width: 100, height: 100 },
      hittable: true,
    },
    {
      index: root + 5,
      depth: 8,
      parentIndex: root,
      type: 'android.widget.FrameLayout',
      label: 'Open more stylus options',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 150, y: 2850, width: 100, height: 100 },
      hittable: true,
    },
    // Key grid: same collapse rule applies, so no per-key noise either.
    ...Array.from({ length: 10 }, (_, key) => ({
      index: root + 6 + key,
      depth: 11,
      parentIndex: root,
      type: 'android.inputmethodservice.Keyboard$Key',
      label: String.fromCharCode(97 + key),
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: key * 130, y: 2100, width: 120, height: 130 },
      hittable: true,
    })),
  ];
}

function androidAppNodes() {
  return [
    {
      index: 0,
      depth: 5,
      type: 'android.widget.EditText',
      label: 'Hello world 3',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 60, y: 400, width: 1200, height: 100 },
      hittable: true,
      focused: true,
    },
    {
      index: 1,
      depth: 5,
      type: 'android.widget.Button',
      label: 'Discard and go back',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 60, y: 550, width: 400, height: 100 },
      hittable: true,
    },
    {
      index: 2,
      depth: 5,
      type: 'android.widget.Button',
      label: 'Push Article',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 60, y: 700, width: 400, height: 100 },
      hittable: true,
    },
  ];
}

test('Android status bar and IME chrome never spend the settled diff budget (#1198)', async () => {
  // The status bar clock ticks and the keyboard is summoned between captures
  // — exactly the noise the July 2026 Android settle benchmark flagged. The
  // systemui status bar disappears entirely (both sides) and the IME
  // collapses to its one container line.
  const before = makeSnapshotState([...androidAppNodes(), ...androidStatusBarNodes(10, '12:23')]);
  const settledTree = makeSnapshotState([
    ...androidAppNodes(),
    ...androidStatusBarNodes(10, '12:24'),
    ...androidImeNodes(30),
  ]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    appBundleId: ANDROID_APP_BUNDLE_ID,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : settledTree };
    },
  });

  const result = await device.interactions.press(selector('label="Discard and go back"'), {
    session: 'default',
    settle: {},
  });

  const diff = result.settle?.diff;
  assert.ok(diff);
  const texts = diff.lines.map((line) => line.text).join('\n');
  // Status bar churn (clock tick, signal/battery text) never appears.
  assert.ok(!/12:2[34]|T-Mobile|Battery/.test(texts));
  // IME toolbar buttons and the per-key grid never appear.
  assert.ok(!/Delete|Done|voice typing|emoji keyboard|stylus/i.test(texts));
  assert.ok(!diff.lines.some((line) => /^@e\S+ \[group\] "[a-j]"$/.test(line.text)));
  // Only the IME container line is added; nothing else changed.
  assert.equal(diff.summary.additions, 1);
  assert.equal(diff.summary.removals, 0);
});

test('Android IME-only settle changes do not suppress the settle tail, and chrome never populates it (#1198)', async () => {
  // Mirrors the iOS "keyboard-only changes... do not suppress" case above:
  // the only tree change is the keyboard summoning (plus unrelated status
  // bar churn), so the tail must still surface the real screen buttons —
  // never the IME toolbar or status bar nodes that used to flood it.
  const before = makeSnapshotState([...androidAppNodes(), ...androidStatusBarNodes(10, '12:23')]);
  const settledTree = makeSnapshotState([
    ...androidAppNodes(),
    ...androidStatusBarNodes(10, '12:24'),
    ...androidImeNodes(30),
  ]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    appBundleId: ANDROID_APP_BUNDLE_ID,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : settledTree };
    },
  });

  const result = await device.interactions.press(selector('label="Discard and go back"'), {
    session: 'default',
    settle: {},
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.diff?.summary.additions, 1);
  assert.ok(settle.tail, 'keyboard-only additions must not suppress the tail');
  assert.deepEqual(
    settle.tail?.map((entry) => entry.label),
    ['Hello world 3', 'Discard and go back', 'Push Article'],
  );
});

test('an Android IME-looking root hosting app-owned content is never collapsed as chrome (#1198)', async () => {
  // Per-node classification: the app-owned "Send" under an IME root survives;
  // the sibling "q" key is dropped for its own foreign package, not by
  // subtree collapse. Indexes start above androidAppNodes()'s 0-2.
  const mixedRoot = [
    {
      index: 10,
      depth: 0,
      type: 'android.widget.FrameLayout',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 0, y: 159, width: 1344, height: 2833 },
      hittable: true,
    },
    {
      index: 11,
      depth: 1,
      parentIndex: 10,
      type: 'android.widget.Button',
      label: 'Send',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 20, y: 200, width: 100, height: 60 },
      hittable: true,
    },
    {
      index: 12,
      depth: 1,
      parentIndex: 10,
      type: 'android.inputmethodservice.Keyboard$Key',
      label: 'q',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 5, y: 590, width: 39, height: 54 },
      hittable: true,
    },
  ];
  const before = makeSnapshotState([...androidAppNodes()]);
  const settledTree = makeSnapshotState([...androidAppNodes(), ...mixedRoot]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    appBundleId: ANDROID_APP_BUNDLE_ID,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : settledTree };
    },
  });

  const result = await device.interactions.press(selector('label="Discard and go back"'), {
    session: 'default',
    settle: {},
  });

  const diff = result.settle?.diff;
  assert.ok(diff);
  const texts = diff.lines.map((line) => line.text).join('\n');
  // The app-owned button always survives.
  assert.match(texts, /Send/);
  // The foreign "q" key is still dropped by the independent app-scope rule
  // (it is simply foreign content, never app-owned) — just not because the
  // whole root got collapsed as chrome, which would have taken "Send" with it.
  assert.ok(!diff.lines.some((line) => /"q"/.test(line.text)));
});

test('a real capture with a cross-window parentIndex artifact never loses app content to IME collapse (#1198)', () => {
  // Real `snapshot -i --json` capture (RN playground, emulator, Gboard up):
  // interactive-only pruning reparented the app's "Tab View, back" (index 6)
  // onto IME toolbar button index 5 — a subtree walk from the IME root would
  // hide the whole screen (indexes 6-13); per-node classification must not.
  const settledNodes = makeSnapshotState([
    {
      index: 0,
      depth: 6,
      type: 'android.widget.FrameLayout',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 24, y: 1152, width: 168, height: 792 },
      hittable: true,
    },
    {
      index: 1,
      depth: 8,
      parentIndex: 0,
      type: 'android.speech.SpeechRecognizer.VoiceDictationButton',
      label: 'Use voice typing',
      identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 36, y: 1164, width: 144, height: 144 },
      hittable: true,
    },
    {
      index: 2,
      depth: 9,
      parentIndex: 0,
      type: 'android.widget.FrameLayout',
      label: 'Delete',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 36, y: 1320, width: 144, height: 144 },
      hittable: true,
    },
    {
      index: 3,
      depth: 9,
      parentIndex: 0,
      type: 'android.widget.FrameLayout',
      label: 'Done',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 1164, y: 1320, width: 144, height: 144 },
      hittable: true,
    },
    {
      index: 4,
      depth: 9,
      parentIndex: 0,
      type: 'android.widget.FrameLayout',
      label: 'Show emoji keyboard',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 36, y: 1476, width: 144, height: 144 },
      hittable: true,
    },
    {
      // The last IME toolbar button — the real capture's app content chains
      // off THIS node's index (5), not off the IME root (0).
      index: 5,
      depth: 9,
      parentIndex: 0,
      type: 'android.widget.FrameLayout',
      label: 'Open more stylus options',
      bundleId: ANDROID_IME_BUNDLE_ID,
      rect: { x: 1164, y: 1476, width: 144, height: 144 },
      hittable: true,
    },
    {
      index: 6,
      depth: 2,
      parentIndex: 5,
      type: 'android.widget.Button',
      label: 'Tab View, back',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 36, y: 108, width: 108, height: 108 },
      hittable: true,
    },
    {
      index: 7,
      depth: 3,
      parentIndex: 6,
      type: 'android.widget.TextView',
      label: 'arrow_back',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 60, y: 132, width: 60, height: 60 },
    },
    {
      index: 8,
      depth: 2,
      parentIndex: 5,
      type: 'android.widget.ScrollView',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 0, y: 216, width: 1344, height: 2600 },
      hittable: true,
    },
    {
      index: 9,
      depth: 3,
      parentIndex: 8,
      type: 'android.widget.EditText',
      label: 'hello from the fixed settle',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 60, y: 400, width: 1200, height: 100 },
      hittable: true,
      focused: true,
    },
    {
      index: 10,
      depth: 3,
      parentIndex: 8,
      type: 'android.widget.Button',
      label: 'Discard and go back',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 60, y: 550, width: 400, height: 100 },
      hittable: true,
    },
    {
      index: 11,
      depth: 4,
      parentIndex: 10,
      type: 'android.widget.TextView',
      label: 'Discard and go back',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 80, y: 570, width: 360, height: 60 },
    },
    {
      index: 12,
      depth: 3,
      parentIndex: 8,
      type: 'android.widget.Button',
      label: 'Push Article',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 60, y: 700, width: 400, height: 100 },
      hittable: true,
    },
    {
      index: 13,
      depth: 4,
      parentIndex: 12,
      type: 'android.widget.TextView',
      label: 'Push Article',
      bundleId: ANDROID_APP_BUNDLE_ID,
      rect: { x: 80, y: 720, width: 360, height: 60 },
    },
  ]).nodes;

  // Every app-content line survives whether or not the session even knows
  // its own appBundleId — the per-node IME rule alone is enough here, since
  // none of these nodes are foreign-but-not-IME.
  for (const appBundleId of [undefined, ANDROID_APP_BUNDLE_ID]) {
    const result = buildSettleTailEntries(settledNodes, new Set(), appBundleId);
    assert.deepEqual(
      result.tail?.map((entry) => entry.label),
      [
        'Tab View, back',
        'arrow_back',
        undefined, // ScrollView: no label
        'hello from the fixed settle',
        'Discard and go back',
        'Discard and go back',
        'Push Article',
        'Push Article',
      ],
    );
  }
});

// Real Android Sharesheet (`am start -a android.intent.action.SEND`,
// ResolverActivity) captured live via `snapshot --raw --json` on the same
// emulator/session as the other #1198 fixtures: 41 nodes, every one owned by
// package `android` — the shape shared by permission prompts, the package
// installer, and chooser/resolver sheets. Indexes offset by +100 to stay
// clear of androidAppNodes().
function androidSharesheetNodes() {
  return [
    {
      index: 100,
      depth: 0,
      type: 'android.widget.FrameLayout',
      bundleId: 'android',
      rect: { x: 0, y: 0, width: 1344, height: 2992 },
    },
    {
      index: 101,
      depth: 1,
      parentIndex: 100,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 0, y: 0, width: 1344, height: 2992 },
    },
    {
      index: 102,
      depth: 2,
      parentIndex: 101,
      type: 'android.widget.FrameLayout',
      identifier: 'android:id/content',
      bundleId: 'android',
      rect: { x: 0, y: 0, width: 1344, height: 2992 },
    },
    {
      index: 103,
      depth: 3,
      parentIndex: 102,
      type: 'android.widget.ScrollView',
      identifier: 'android:id/contentPanel',
      bundleId: 'android',
      rect: { x: 0, y: 0, width: 1344, height: 2992 },
    },
    {
      index: 104,
      depth: 4,
      parentIndex: 103,
      type: 'android.widget.RelativeLayout',
      identifier: 'android:id/title_container',
      bundleId: 'android',
      rect: { x: 0, y: 1937, width: 1344, height: 191 },
    },
    {
      index: 105,
      depth: 5,
      parentIndex: 104,
      type: 'android.widget.TextView',
      label: 'Share',
      identifier: 'android:id/title',
      bundleId: 'android',
      rect: { x: 72, y: 1991, width: 1200, height: 65 },
    },
    {
      index: 106,
      depth: 4,
      parentIndex: 103,
      type: 'android.view.View',
      identifier: 'android:id/divider',
      bundleId: 'android',
      rect: { x: 0, y: 2128, width: 1344, height: 3 },
    },
    {
      index: 107,
      depth: 4,
      parentIndex: 103,
      type: 'android.widget.TabHost',
      identifier: 'android:id/profile_tabhost',
      bundleId: 'android',
      rect: { x: 0, y: 2131, width: 1344, height: 861 },
    },
    {
      index: 108,
      depth: 5,
      parentIndex: 107,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 0, y: 2131, width: 1344, height: 861 },
    },
    {
      index: 109,
      depth: 6,
      parentIndex: 108,
      type: 'android.widget.FrameLayout',
      identifier: 'android:id/tabcontent',
      bundleId: 'android',
      rect: { x: 0, y: 2131, width: 1344, height: 861 },
    },
    {
      index: 110,
      depth: 7,
      parentIndex: 109,
      type: 'com.android.internal.widget.ViewPager',
      identifier: 'android:id/profile_pager',
      bundleId: 'android',
      rect: { x: 0, y: 2131, width: 1344, height: 861 },
    },
    {
      index: 111,
      depth: 8,
      parentIndex: 110,
      type: 'android.widget.RelativeLayout',
      bundleId: 'android',
      rect: { x: 0, y: 2131, width: 1344, height: 861 },
    },
    {
      index: 112,
      depth: 9,
      parentIndex: 111,
      type: 'android.widget.ListView',
      identifier: 'android:id/resolver_list',
      bundleId: 'android',
      rect: { x: 0, y: 2131, width: 1344, height: 861 },
    },
    {
      index: 113,
      depth: 10,
      parentIndex: 112,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 0, y: 2131, width: 1344, height: 168 },
    },
    {
      index: 114,
      depth: 11,
      parentIndex: 113,
      type: 'android.widget.ImageView',
      identifier: 'android:id/icon',
      bundleId: 'android',
      rect: { x: 24, y: 2167, width: 96, height: 96 },
    },
    {
      index: 115,
      depth: 11,
      parentIndex: 113,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 144, y: 2182, width: 326, height: 65 },
    },
    {
      index: 116,
      depth: 12,
      parentIndex: 115,
      type: 'android.widget.TextView',
      label: 'Quick Share',
      identifier: 'android:id/text1',
      bundleId: 'android',
      rect: { x: 144, y: 2182, width: 254, height: 65 },
    },
    {
      index: 117,
      depth: 10,
      parentIndex: 112,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 0, y: 2299, width: 1344, height: 168 },
    },
    {
      index: 118,
      depth: 11,
      parentIndex: 117,
      type: 'android.widget.ImageView',
      identifier: 'android:id/icon',
      bundleId: 'android',
      rect: { x: 24, y: 2335, width: 96, height: 96 },
    },
    {
      index: 119,
      depth: 11,
      parentIndex: 117,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 144, y: 2350, width: 277, height: 65 },
    },
    {
      index: 120,
      depth: 12,
      parentIndex: 119,
      type: 'android.widget.TextView',
      label: 'Bluetooth',
      identifier: 'android:id/text1',
      bundleId: 'android',
      rect: { x: 144, y: 2350, width: 205, height: 65 },
    },
    {
      index: 121,
      depth: 10,
      parentIndex: 112,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 0, y: 2467, width: 1344, height: 168 },
    },
    {
      index: 122,
      depth: 11,
      parentIndex: 121,
      type: 'android.widget.ImageView',
      identifier: 'android:id/icon',
      bundleId: 'android',
      rect: { x: 24, y: 2503, width: 96, height: 96 },
    },
    {
      index: 123,
      depth: 11,
      parentIndex: 121,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 144, y: 2490, width: 197, height: 122 },
    },
    {
      index: 124,
      depth: 12,
      parentIndex: 123,
      type: 'android.widget.TextView',
      label: 'Gmail',
      identifier: 'android:id/text1',
      bundleId: 'android',
      rect: { x: 144, y: 2490, width: 125, height: 65 },
    },
    {
      index: 125,
      depth: 12,
      parentIndex: 123,
      type: 'android.widget.TextView',
      label: 'Chat',
      identifier: 'android:id/text2',
      bundleId: 'android',
      rect: { x: 144, y: 2555, width: 87, height: 57 },
    },
    {
      index: 126,
      depth: 10,
      parentIndex: 112,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 0, y: 2635, width: 1344, height: 168 },
    },
    {
      index: 127,
      depth: 11,
      parentIndex: 126,
      type: 'android.widget.ImageView',
      identifier: 'android:id/icon',
      bundleId: 'android',
      rect: { x: 24, y: 2671, width: 96, height: 96 },
    },
    {
      index: 128,
      depth: 11,
      parentIndex: 126,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 144, y: 2686, width: 239, height: 65 },
    },
    {
      index: 129,
      depth: 12,
      parentIndex: 128,
      type: 'android.widget.TextView',
      label: 'Chrome',
      identifier: 'android:id/text1',
      bundleId: 'android',
      rect: { x: 144, y: 2686, width: 167, height: 65 },
    },
    {
      index: 130,
      depth: 10,
      parentIndex: 112,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 0, y: 2803, width: 1344, height: 168 },
    },
    {
      index: 131,
      depth: 11,
      parentIndex: 130,
      type: 'android.widget.ImageView',
      identifier: 'android:id/icon',
      bundleId: 'android',
      rect: { x: 24, y: 2839, width: 96, height: 96 },
    },
    {
      index: 132,
      depth: 11,
      parentIndex: 130,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 144, y: 2826, width: 399, height: 122 },
    },
    {
      index: 133,
      depth: 12,
      parentIndex: 132,
      type: 'android.widget.TextView',
      label: 'Drive',
      identifier: 'android:id/text1',
      bundleId: 'android',
      rect: { x: 144, y: 2826, width: 108, height: 65 },
    },
    {
      index: 134,
      depth: 12,
      parentIndex: 132,
      type: 'android.widget.TextView',
      label: 'Copy to clipboard',
      identifier: 'android:id/text2',
      bundleId: 'android',
      rect: { x: 144, y: 2891, width: 327, height: 57 },
    },
    {
      index: 135,
      depth: 10,
      parentIndex: 112,
      type: 'android.widget.LinearLayout',
      bundleId: 'android',
      rect: { x: 0, y: 2971, width: 1344, height: 21 },
    },
    {
      index: 136,
      depth: 4,
      parentIndex: 103,
      type: 'android.widget.LinearLayout',
      identifier: 'android:id/button_bar_container',
      bundleId: 'android',
      rect: { x: 0, y: 2707, width: 1344, height: 285 },
    },
    {
      index: 137,
      depth: 5,
      parentIndex: 136,
      type: 'android.view.View',
      identifier: 'android:id/resolver_button_bar_divider',
      bundleId: 'android',
      rect: { x: 0, y: 2707, width: 1344, height: 3 },
    },
    {
      index: 138,
      depth: 5,
      parentIndex: 136,
      type: 'android.widget.LinearLayout',
      identifier: 'android:id/button_bar',
      bundleId: 'android',
      rect: { x: 0, y: 2710, width: 1344, height: 282 },
    },
    {
      index: 139,
      depth: 6,
      parentIndex: 138,
      type: 'android.widget.Button',
      label: 'Just once',
      identifier: 'android:id/button_once',
      bundleId: 'android',
      rect: { x: 829, y: 2734, width: 255, height: 162 },
      hittable: true,
    },
    {
      index: 140,
      depth: 6,
      parentIndex: 138,
      type: 'android.widget.Button',
      label: 'Always',
      identifier: 'android:id/button_always',
      bundleId: 'android',
      rect: { x: 1084, y: 2734, width: 206, height: 162 },
      hittable: true,
    },
  ];
}

test('a system dialog (real Sharesheet capture) stays fully visible in the settled diff (#1198)', async () => {
  // PR #1200 review blocker: the initial fix dropped EVERY foreign package,
  // so a blocking system dialog appearing mid-action produced an empty diff
  // and a tail pointing at now-covered app buttons. Keep-unknown-foreign is
  // the rule now: only IME + persistent system chrome are ever filtered.
  const before = makeSnapshotState([...androidAppNodes()]);
  const settledTree = makeSnapshotState([...androidAppNodes(), ...androidSharesheetNodes()]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    appBundleId: ANDROID_APP_BUNDLE_ID,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : settledTree };
    },
  });

  const result = await device.interactions.press(selector('label="Discard and go back"'), {
    session: 'default',
    settle: {},
  });

  const diff = result.settle?.diff;
  assert.ok(diff);
  // The dialog registers as change, not silence.
  assert.ok(diff.summary.additions > 0, 'dialog additions must appear in the settled diff');
  assert.equal(diff.summary.removals, 0);
  const added = diff.lines.filter((line) => line.kind === 'added');
  const texts = added.map((line) => line.text).join('\n');
  assert.match(texts, /Just once/);
  assert.match(texts, /Always/);
  assert.match(texts, /"Share"/);
  // The dialog's buttons arrive WITH actionable refs.
  assert.ok(
    added.some((line) => /Just once/.test(line.text) && line.ref),
    'dialog buttons must carry refs',
  );
});

// The same live Sharesheet through `snapshot -i --json` — the interactive-only
// shape settled captures actually have (10 nodes; the raw fixture above would
// exhaust the 20-entry tail cap on unlabeled containers alone).
function androidSharesheetInteractiveNodes() {
  return [
    {
      index: 100,
      depth: 3,
      type: 'android.widget.ScrollView',
      bundleId: 'android',
      rect: { x: 0, y: 0, width: 1344, height: 2992 },
    },
    {
      index: 101,
      depth: 12,
      parentIndex: 100,
      type: 'android.widget.TextView',
      label: 'Quick Share',
      bundleId: 'android',
      rect: { x: 144, y: 2182, width: 254, height: 65 },
    },
    {
      index: 102,
      depth: 12,
      parentIndex: 100,
      type: 'android.widget.TextView',
      label: 'Gmail',
      bundleId: 'android',
      rect: { x: 144, y: 2490, width: 125, height: 65 },
    },
    {
      index: 103,
      depth: 12,
      parentIndex: 100,
      type: 'android.widget.TextView',
      label: 'Chrome',
      bundleId: 'android',
      rect: { x: 144, y: 2686, width: 167, height: 65 },
    },
    {
      index: 104,
      depth: 6,
      parentIndex: 100,
      type: 'android.widget.Button',
      label: 'Just once',
      bundleId: 'android',
      rect: { x: 829, y: 2734, width: 255, height: 162 },
      hittable: true,
    },
    {
      index: 105,
      depth: 6,
      parentIndex: 100,
      type: 'android.widget.Button',
      label: 'Always',
      bundleId: 'android',
      rect: { x: 1084, y: 2734, width: 206, height: 162 },
      hittable: true,
    },
  ];
}

test("a system dialog's buttons are settle-tail candidates, never chrome (#1198)", () => {
  const settledNodes = makeSnapshotState([
    ...androidAppNodes(),
    ...androidSharesheetInteractiveNodes(),
  ]).nodes;

  const result = buildSettleTailEntries(settledNodes, new Set(), ANDROID_APP_BUNDLE_ID);

  const labels = (result.tail ?? []).map((entry) => entry.label);
  assert.ok(labels.includes('Just once'), `tail must list the dialog buttons, got: ${labels}`);
  assert.ok(labels.includes('Always'), `tail must list the dialog buttons, got: ${labels}`);
});

test('added lines win diff-budget slots over removals under truncation', async () => {
  // 120 removals precede the additions positionally; the fresh-ref additions
  // must still survive the 80-line cap.
  const bigBefore = makeSnapshotState(
    Array.from({ length: 120 }, (_, index) => ({
      index,
      depth: 0,
      type: 'StaticText',
      label: `Old row ${index}`,
      rect: { x: 0, y: index * 20, width: 100, height: 20 },
      hittable: true,
    })),
  );
  const afterTree = makeSnapshotState(
    Array.from({ length: 10 }, (_, index) => ({
      index,
      depth: 0,
      type: 'Button',
      label: `New action ${index}`,
      rect: { x: 0, y: index * 40, width: 100, height: 40 },
      hittable: true,
    })),
  );
  let captures = 0;
  const device = createSettleDevice({
    stored: bigBefore,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? bigBefore : afterTree };
    },
  });

  const result = await device.interactions.press(selector('label="Old row 0"'), {
    session: 'default',
    settle: {},
  });

  const diff = result.settle?.diff;
  assert.ok(diff);
  assert.equal(diff.truncated, true);
  assert.equal(diff.lines.length, 80);
  const added = diff.lines.filter((line) => line.kind === 'added');
  assert.equal(added.length, 10);
  assert.ok(added.every((line) => line.ref !== undefined));
});

// Unchanged interactive refs tail: benchmarks showed a removals-only settled
// diff (modal dismiss, toast dismiss) leaves the next actionable target
// invisible — the diff has nothing added to hand back. The tail fills that
// gap from the settled tree itself.

function modalBeforeSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Add to cart',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
    {
      index: 1,
      depth: 0,
      type: 'StaticText',
      label: 'Price: $12',
      rect: { x: 10, y: 80, width: 100, height: 20 },
    },
    {
      index: 2,
      depth: 0,
      type: 'Button',
      label: 'OK',
      rect: { x: 10, y: 140, width: 100, height: 40 },
      hittable: true,
    },
    {
      index: 3,
      depth: 0,
      type: 'Button',
      label: 'Cancel',
      rect: { x: 10, y: 200, width: 100, height: 40 },
      hittable: true,
    },
    {
      index: 4,
      depth: 0,
      type: 'StaticText',
      label: 'Are you sure?',
      rect: { x: 10, y: 260, width: 100, height: 20 },
    },
  ]);
}

// Modal dismissed: only the background elements survive, and every one of
// them matches a `modalBeforeSnapshot` line exactly (unchanged), so the diff
// carries zero additions.
function modalDismissedSnapshot(): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Add to cart',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
    {
      index: 1,
      depth: 0,
      type: 'StaticText',
      label: 'Price: $12',
      rect: { x: 10, y: 80, width: 100, height: 20 },
    },
  ]);
}

test('a removals-only settled diff (modal dismiss) attaches an unchanged interactive tail', async () => {
  const before = modalBeforeSnapshot();
  const after = modalDismissedSnapshot();
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : after };
    },
  });

  const result = await device.interactions.press(selector('label=OK'), {
    session: 'default',
    settle: {},
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.deepEqual(settle.diff?.summary, { additions: 0, removals: 3, unchanged: 2 });
  assert.ok(!settle.diff?.lines.some((line) => line.kind === 'added'));
  // The tail matches `snapshot -i`'s own bar for the settled tree: both
  // surviving elements are candidates, `hittable` is not required (#1167 post-
  // merge benchmark: real buttons commonly report `hittable: false`/undefined
  // right after a dismiss animation, so requiring it silently dropped exactly
  // the elements the tail exists to surface).
  assert.deepEqual(settle.tail, [
    { ref: 'e1', role: 'button', label: 'Add to cart' },
    { ref: 'e2', role: 'text', label: 'Price: $12' },
  ]);
  assert.equal(settle.tailTruncated, undefined);
});

test('the unchanged interactive tail includes non-hittable candidates but excludes covered ones', async () => {
  // Every surviving node's attributes (hittable/blocked-relevant fields) must
  // match a `before` line exactly, or it would read as an added line and
  // suppress the tail entirely (see the trigger-condition test above).
  const survivors = [
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Add to cart',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: false,
    },
    {
      index: 1,
      depth: 0,
      type: 'Button',
      label: 'Wishlist',
      rect: { x: 10, y: 80, width: 100, height: 40 },
      hittable: true,
    },
    {
      index: 2,
      depth: 0,
      type: 'Button',
      label: 'Share',
      rect: { x: 10, y: 140, width: 100, height: 40 },
      hittable: true,
    },
  ];
  const before = makeSnapshotState([
    ...survivors,
    {
      index: 3,
      depth: 0,
      type: 'Button',
      label: 'OK',
      rect: { x: 10, y: 200, width: 100, height: 40 },
      hittable: true,
    },
    {
      index: 4,
      depth: 0,
      type: 'Button',
      label: 'Cancel',
      rect: { x: 10, y: 260, width: 100, height: 40 },
      hittable: true,
    },
  ]);
  // Same attributes as `survivors`; `interactionBlocked` is not part of the
  // comparable key, so marking Wishlist covered here does not flip it to
  // "added".
  const after = makeSnapshotState([
    survivors[0]!,
    { ...survivors[1]!, interactionBlocked: 'covered' as const },
    survivors[2]!,
  ]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : after };
    },
  });

  const result = await device.interactions.press(selector('label=OK'), {
    session: 'default',
    settle: {},
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.diff?.summary.additions, 0);
  // `hittable: false` no longer excludes a candidate (matches `snapshot -i`'s
  // own bar); `interactionBlocked: 'covered'` still does.
  assert.deepEqual(settle.tail, [
    { ref: 'e1', role: 'button', label: 'Add to cart' },
    { ref: 'e3', role: 'button', label: 'Share' },
  ]);
});

test('the unchanged interactive tail excludes structural application/window chrome', async () => {
  // The flagship #1167 post-merge benchmark case: after a dialog dismiss, the
  // old `hittable === true` bar let a lone application/window pair through
  // (both routinely report `hittable: true` on their full-screen root frame)
  // while excluding the real button because its `hittable` state was
  // undefined right after the dismiss animation.
  const before = makeSnapshotState([
    { index: 0, depth: 0, type: 'Application', label: 'React Navigation Example' },
    { index: 1, depth: 0, type: 'Window' },
    {
      index: 2,
      depth: 0,
      type: 'Button',
      label: 'Discard and go back',
      rect: { x: 10, y: 20, width: 200, height: 40 },
    },
    {
      index: 3,
      depth: 0,
      type: 'Button',
      label: 'Cancel',
      rect: { x: 10, y: 80, width: 200, height: 40 },
    },
  ]);
  // The dialog's own Cancel button is dismissed with it; the application,
  // window, and the real actionable button survive unchanged. None of the
  // three carry `hittable: true` here, mirroring the real post-dismiss
  // capture shape.
  const after = makeSnapshotState([
    { index: 0, depth: 0, type: 'Application', label: 'React Navigation Example' },
    { index: 1, depth: 0, type: 'Window' },
    {
      index: 2,
      depth: 0,
      type: 'Button',
      label: 'Discard and go back',
      rect: { x: 10, y: 20, width: 200, height: 40 },
    },
  ]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : after };
    },
  });

  const result = await device.interactions.press(selector('label=Cancel'), {
    session: 'default',
    settle: {},
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.diff?.summary.additions, 0);
  // Application/window chrome is dropped; the real button is the only entry,
  // despite carrying no `hittable: true` flag.
  assert.deepEqual(settle.tail, [{ ref: 'e3', role: 'button', label: 'Discard and go back' }]);
});

test('the unchanged interactive tail is capped with a truncation marker', async () => {
  const buttons = (labelPrefix: string, count: number, offset = 0) =>
    Array.from({ length: count }, (_, index) => ({
      index: index + offset,
      depth: 0,
      type: 'Button',
      label: `${labelPrefix} ${index}`,
      rect: { x: 0, y: index * 40, width: 100, height: 40 },
      hittable: true,
    }));
  // 25 surviving buttons plus 2 modal-only buttons that get removed.
  const before = makeSnapshotState([...buttons('Row', 25), ...buttons('Modal', 2, 25)]);
  const after = makeSnapshotState(buttons('Row', 25));
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : after };
    },
  });

  const result = await device.interactions.press(selector('label="Modal 0"'), {
    session: 'default',
    settle: {},
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.diff?.summary.additions, 0);
  assert.equal(settle.tail?.length, 20);
  assert.equal(settle.tailTruncated, true);
});

test('buildSettleTailEntries dedups candidates already carrying an excluded ref', () => {
  const settledNodes = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Add to cart',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
    {
      index: 1,
      depth: 0,
      type: 'Button',
      label: 'Share',
      rect: { x: 10, y: 80, width: 100, height: 40 },
      hittable: true,
    },
  ]).nodes;

  const result = buildSettleTailEntries(settledNodes, new Set(['e1']));

  assert.deepEqual(result.tail, [{ ref: 'e2', role: 'button', label: 'Share' }]);
});

test('buildSettleTailEntries drops application/window chrome and does not require hittable', () => {
  const settledNodes = makeSnapshotState([
    { index: 0, depth: 0, type: 'Application', label: 'Example' },
    { index: 1, depth: 0, type: 'Window' },
    {
      index: 2,
      depth: 0,
      type: 'Button',
      label: 'Discard and go back',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      // Deliberately no `hittable` field, mirroring a real post-dismiss
      // capture: the tail bar no longer requires `hittable === true`.
    },
  ]).nodes;

  const result = buildSettleTailEntries(settledNodes, new Set());

  assert.deepEqual(result.tail, [{ ref: 'e3', role: 'button', label: 'Discard and go back' }]);
});

test('buildSettleTailEntries drops the keyboard container and its chrome descendants', () => {
  const settledNodes = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Send',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
    { index: 1, depth: 0, type: 'Keyboard', label: 'keyboard' },
    { index: 2, depth: 1, parentIndex: 1, type: 'Key', label: 'q' },
    { index: 3, depth: 1, parentIndex: 1, type: 'Button', label: 'shift' },
  ]).nodes;

  const result = buildSettleTailEntries(settledNodes, new Set());

  assert.deepEqual(result.tail, [{ ref: 'e1', role: 'button', label: 'Send' }]);
});

test('buildSettleTailEntries drops Android IME chrome and status-bar chrome (#1198)', () => {
  const settledNodes = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'android.widget.Button',
      label: 'Send',
      bundleId: 'org.reactnavigation.playground',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
    {
      // Status-bar marker: this systemui run drops whole.
      index: 1,
      depth: 0,
      type: 'android.widget.FrameLayout',
      identifier: 'com.android.systemui:id/status_bar',
      bundleId: 'com.android.systemui',
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 1,
      type: 'android.widget.TextView',
      identifier: 'com.android.systemui:id/clock',
      label: '12:23',
      bundleId: 'com.android.systemui',
    },
    {
      index: 3,
      depth: 0,
      type: 'android.widget.FrameLayout',
      bundleId: 'com.google.android.inputmethod.latin',
      hittable: true,
    },
    {
      index: 4,
      depth: 1,
      parentIndex: 3,
      type: 'android.widget.FrameLayout',
      label: 'Delete',
      bundleId: 'com.google.android.inputmethod.latin',
      hittable: true,
    },
  ]).nodes;

  const result = buildSettleTailEntries(settledNodes, new Set(), 'org.reactnavigation.playground');

  assert.deepEqual(result.tail, [{ ref: 'e1', role: 'button', label: 'Send' }]);
});

test('buildSettleTailEntries keeps unknown-foreign packages and drops only marked systemui chrome, with or without appBundleId (#1198)', () => {
  // Keep-unknown-foreign default: a system dialog's buttons (package
  // `android`) stay tail candidates; only the marked status/nav-bar
  // window-run drops, and that does not depend on knowing the session's app.
  const settledNodes = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'android.widget.Button',
      label: 'Send',
      bundleId: 'org.reactnavigation.playground',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
    {
      index: 1,
      depth: 0,
      type: 'android.widget.FrameLayout',
      identifier: 'com.android.systemui:id/status_bar_container',
      bundleId: 'com.android.systemui',
      rect: { x: 0, y: 0, width: 1344, height: 159 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 1,
      type: 'android.widget.TextView',
      identifier: 'com.android.systemui:id/clock',
      label: '12:23',
      bundleId: 'com.android.systemui',
      rect: { x: 40, y: 40, width: 80, height: 40 },
    },
    {
      index: 3,
      depth: 0,
      type: 'android.widget.Button',
      label: 'Just once',
      identifier: 'android:id/button_once',
      bundleId: 'android',
      rect: { x: 829, y: 2734, width: 255, height: 162 },
      hittable: true,
    },
  ]).nodes;

  for (const appBundleId of [undefined, 'org.reactnavigation.playground']) {
    const result = buildSettleTailEntries(settledNodes, new Set(), appBundleId);
    assert.deepEqual(
      result.tail?.map((entry) => entry.label),
      ['Send', 'Just once'],
    );
  }
});

test('a systemui volume dialog survives the settled diff and tail while the status bar drops (#1198)', async () => {
  // PR #1200 second review round: systemui is not all chrome — it hosts
  // actionable overlays (volume panel, media pickers). Only window-runs
  // carrying a status/nav-bar marker drop; the VolumeDialog run (real
  // capture, same package, volume_dialog* ids only) must stay actionable.
  const before = makeSnapshotState([...androidAppNodes(), ...androidStatusBarNodes(10, '12:23')]);
  const settledTree = makeSnapshotState([
    ...androidAppNodes(),
    ...androidStatusBarNodes(10, '12:24'),
    ...androidVolumeDialogNodes(30),
  ]);
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    appBundleId: ANDROID_APP_BUNDLE_ID,
    captureSnapshot: () => {
      captures += 1;
      return { snapshot: captures === 1 ? before : settledTree };
    },
  });

  const result = await device.interactions.press(selector('label="Discard and go back"'), {
    session: 'default',
    settle: {},
  });

  const diff = result.settle?.diff;
  assert.ok(diff);
  const added = diff.lines.filter((line) => line.kind === 'added');
  const texts = added.map((line) => line.text).join('\n');
  // The volume dialog registers as change, with actionable refs.
  assert.match(texts, /Sound settings/);
  assert.match(texts, /Media/);
  assert.ok(
    added.some((line) => /Sound settings/.test(line.text) && line.ref),
    'volume dialog controls must carry refs',
  );
  // Status-bar churn (clock tick) still never appears.
  assert.ok(!/12:2[34]/.test(diff.lines.map((line) => line.text).join('\n')));

  // Tail-candidate check on the same shape: dialog controls are candidates,
  // status-bar nodes are not.
  const labels = (
    buildSettleTailEntries(settledTree.nodes, new Set(), ANDROID_APP_BUNDLE_ID).tail ?? []
  ).map((entry) => entry.label);
  assert.ok(labels.includes('Sound settings'), `tail must list dialog controls, got: ${labels}`);
  assert.ok(!labels.includes('12:24'), 'status bar must stay excluded');
});
