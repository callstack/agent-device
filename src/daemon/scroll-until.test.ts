import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  SCROLL_UNTIL_PASS_LIMIT,
  formatScrollUntilMessage,
  runScrollUntilVisible,
  type ScrollUntilCapture,
} from './scroll-until.ts';

const VIEWPORT = { x: 0, y: 0, width: 400, height: 800 };
const SPARSE = { state: 'sparse', backend: 'tree', reason: 'AX bridge unavailable' } as const;

/** A scrollable whose single row sits at `rowY`; below 800 is off-screen with content beneath. */
function tree(rowY: number, label = 'Email'): SnapshotNode[] {
  return [
    { index: 0, ref: 'e1', type: 'Application', rect: VIEWPORT } as SnapshotNode,
    { index: 1, parentIndex: 0, ref: 'e2', type: 'ScrollView', rect: VIEWPORT } as SnapshotNode,
    {
      index: 2,
      parentIndex: 1,
      ref: 'e3',
      type: 'TextField',
      label,
      rect: { x: 0, y: rowY, width: 400, height: 40 },
    } as SnapshotNode,
  ];
}

async function run(params: {
  captures: ScrollUntilCapture[];
  selector?: string;
  passLimit?: number;
  onScroll?: () => void;
}) {
  let index = 0;
  return await runScrollUntilVisible({
    selector: params.selector ?? 'label=Email',
    direction: 'down',
    platform: 'ios',
    ...(params.passLimit === undefined ? {} : { passLimit: params.passLimit }),
    capture: async () => params.captures[Math.min(index++, params.captures.length - 1)]!,
    scroll: async () => {
      params.onScroll?.();
      return { pixels: 480 };
    },
  });
}

test('an already visible target costs one capture and no gesture', async () => {
  let scrolls = 0;
  const result = await run({ captures: [{ nodes: tree(200) }], onScroll: () => (scrolls += 1) });
  assert.equal(result.passes, 0);
  assert.equal(scrolls, 0);
  assert.equal(result.result, undefined);
});

test('passes repeat until the selector is on screen, and the last gesture is reported', async () => {
  let scrolls = 0;
  const result = await run({
    captures: [{ nodes: tree(2400) }, { nodes: tree(1600) }, { nodes: tree(200) }],
    onScroll: () => (scrolls += 1),
  });
  assert.equal(result.passes, 2);
  assert.equal(scrolls, 2);
  assert.deepEqual(result.result, { pixels: 480 });
});

/**
 * A target below the fold is present but not visible. Stopping on presence would leave the caller
 * with a row it cannot act on, which is the whole reason the check asks about the viewport.
 */
test('a present but scrolled-out target does not end the loop', async () => {
  await assert.rejects(
    () => run({ captures: [{ nodes: tree(2400) }], passLimit: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'scroll_until_pass_limit');
      return true;
    },
  );
});

test('running out of content stops before the pass budget does', async () => {
  let scrolls = 0;
  await assert.rejects(
    () =>
      run({
        // The row is on screen, so nothing is hidden below and the selector matches nothing.
        captures: [{ nodes: tree(200, 'Other') }],
        onScroll: () => (scrolls += 1),
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'scroll_until_edge_reached');
      assert.match(String(error.details?.hint), /scroll the opposite direction/);
      return true;
    },
  );
  assert.equal(scrolls, 0);
});

test('a horizontal scroll has no edge signal and is bounded by the budget alone', async () => {
  let scrolls = 0;
  await assert.rejects(
    () =>
      runScrollUntilVisible({
        selector: 'label=Missing',
        direction: 'right',
        platform: 'ios',
        passLimit: 3,
        capture: async () => ({ nodes: tree(200) }),
        scroll: async () => {
          scrolls += 1;
          return {};
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'scroll_until_pass_limit');
      assert.equal(error.details?.passes, 3);
      return true;
    },
  );
  assert.equal(scrolls, 3);
});

test('the default budget is the shared constant', async () => {
  await assert.rejects(
    () =>
      runScrollUntilVisible({
        selector: 'label=Missing',
        direction: 'right',
        platform: 'ios',
        capture: async () => ({ nodes: tree(200) }),
        scroll: async () => ({}),
      }),
    (error: unknown) =>
      error instanceof AppError && error.details?.passes === SCROLL_UNTIL_PASS_LIMIT,
  );
});

/**
 * The defect this pins: coercing an unreadable capture to an empty tree makes the edge analyzer
 * report "no room below", so a failed read used to be reported as end-of-content. Each case counts
 * gestures, so the refusal is proven to land before matching, edge analysis or scrolling.
 */
test('an unreadable capture is refused rather than read as end-of-content', async () => {
  for (const capture of [{}, { nodes: [] }] satisfies ScrollUntilCapture[]) {
    let scrolls = 0;
    await assert.rejects(
      () => run({ captures: [capture], onScroll: () => (scrolls += 1) }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'scroll_until_capture_unreadable');
        assert.equal(error.details?.captureRefusal, 'no-capture');
        return true;
      },
    );
    assert.equal(scrolls, 0);
  }
});

/**
 * The verdict arrives under two spellings: `SnapshotState` says `snapshotQuality`, a backend result
 * says `quality` and can nest a state as well. Reading only one is how a real backend sparse verdict
 * went unread once. Every arrangement carries content below the fold, so an edge verdict would be
 * wrong here too.
 */
test('a sparse verdict is refused under every spelling a capture can carry it in', async () => {
  const arrangements: ScrollUntilCapture[] = [
    { nodes: tree(2400), snapshotQuality: SPARSE },
    { nodes: tree(2400), quality: SPARSE },
    { quality: SPARSE, snapshot: { nodes: tree(2400) } },
    { snapshot: { nodes: tree(2400), snapshotQuality: SPARSE } },
  ];
  for (const capture of arrangements) {
    let scrolls = 0;
    await assert.rejects(
      () => run({ captures: [capture], onScroll: () => (scrolls += 1) }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.captureRefusal, 'sparse-tree');
        assert.match(String(error.message), /AX bridge unavailable/);
        return true;
      },
    );
    assert.equal(scrolls, 0);
  }
});

test('the legacy iOS application-root-only shape is refused', async () => {
  await assert.rejects(
    () =>
      run({
        captures: [
          {
            backend: 'xctest',
            nodes: [{ index: 0, ref: 'e1', type: 'Application', rect: VIEWPORT } as SnapshotNode],
          },
        ],
      }),
    (error: unknown) =>
      error instanceof AppError && error.details?.captureRefusal === 'sparse-tree',
  );
});

test('a malformed quality payload is not mistaken for a verdict', async () => {
  const result = await run({ captures: [{ nodes: tree(200), quality: { state: 'not-a-state' } }] });
  assert.equal(result.passes, 0);
});

/**
 * A tree the backend vouches for is readable, and so is one whose tail was truncated: truncation
 * drops content, it does not make the capture untrustworthy.
 */
test('a populated capture is not refused, healthy or recovered', async () => {
  for (const state of ['healthy', 'recovered'] as const) {
    const result = await run({
      captures: [{ nodes: tree(200), snapshotQuality: { state, backend: 'tree' } }],
    });
    assert.equal(result.passes, 0);
  }
});

test('the success message distinguishes an already visible target from a scrolled one', () => {
  assert.equal(
    formatScrollUntilMessage('down', 'id=email', 0),
    'id=email was already visible; no down scroll needed',
  );
  assert.equal(
    formatScrollUntilMessage('down', 'id=email', 1),
    'Scrolled down 1 pass until id=email was visible',
  );
  assert.equal(
    formatScrollUntilMessage('down', 'id=email', 3),
    'Scrolled down 3 passes until id=email was visible',
  );
});
