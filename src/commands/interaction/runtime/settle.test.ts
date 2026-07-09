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
    sessions: createMemorySessionStore([{ name: 'default', snapshot: params.stored }]),
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
