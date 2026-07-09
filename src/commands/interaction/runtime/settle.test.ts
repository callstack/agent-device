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

test('keyboard Key nodes never spend the settled diff budget', async () => {
  const before = buttonSnapshot();
  // A fill-style settled tree: a summoned keyboard (container + keys) plus the
  // content change the agent actually cares about.
  const keyboardTree = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'StaticText',
      label: 'Results for alpenglow',
      rect: { x: 0, y: 0, width: 200, height: 20 },
      hittable: true,
    },
    {
      index: 1,
      depth: 0,
      type: 'Keyboard',
      label: 'keyboard',
      rect: { x: 0, y: 500, width: 400, height: 300 },
      hittable: true,
    },
    ...Array.from({ length: 26 }, (_, key) => ({
      index: key + 2,
      depth: 1,
      parentIndex: 1,
      type: 'Key',
      label: String.fromCharCode(97 + key),
      rect: { x: key * 10, y: 520, width: 10, height: 40 },
      hittable: true,
    })),
    ...['Next', 'Back', 'Home'].map((label, extra) => ({
      index: extra + 28,
      depth: 0,
      type: 'Button',
      label,
      rect: { x: 0, y: 40 + extra * 40, width: 100, height: 40 },
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
  assert.match(texts, /keyboard/);
  // The container line survives as the keyboard signal; individual keys do not.
  assert.ok(!diff.lines.some((line) => /\[key\]/.test(line.text)));
  assert.equal(diff.summary.additions, 5);
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
  // The StaticText survives but is not interactive; only the hittable button
  // makes the tail.
  assert.deepEqual(settle.tail, [{ ref: 'e1', role: 'button', label: 'Add to cart' }]);
  assert.equal(settle.tailTruncated, undefined);
});

test('the unchanged interactive tail excludes non-hittable and covered candidates', async () => {
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
  // Not hittable, then covered, are both excluded; only the plain hittable
  // button remains.
  assert.deepEqual(settle.tail, [{ ref: 'e3', role: 'button', label: 'Share' }]);
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
