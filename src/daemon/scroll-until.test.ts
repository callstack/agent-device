import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotResult } from '@agent-device/contracts/interactor-types';
import {
  SCROLL_UNTIL_PASS_LIMIT,
  formatScrollUntilMessage,
  runScrollUntilVisible,
} from './scroll-until.ts';

/** The provenance every `SnapshotResult` carries; the fields under test are the rest. */
function capture(fields: Partial<SnapshotResult>): SnapshotResult {
  return { backend: 'xctest', producer: 'runner', ...fields } as SnapshotResult;
}

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
  captures: SnapshotResult[];
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
  const result = await run({
    captures: [capture({ nodes: tree(200) })],
    onScroll: () => (scrolls += 1),
  });
  assert.equal(result.passes, 0);
  assert.equal(scrolls, 0);
  assert.equal(result.result, undefined);
});

test('passes repeat until the selector is on screen, and the last gesture is reported', async () => {
  let scrolls = 0;
  const result = await run({
    captures: [tree(2400), tree(1600), tree(200)].map((nodes) => capture({ nodes })),
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
    () => run({ captures: [capture({ nodes: tree(2400) })], passLimit: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'scroll_until_pass_limit');
      return true;
    },
  );
});

/**
 * The stuck-container defect: content below the fold, so the edge analyzer says "keep going", but the
 * gesture never moves this scroller, so every capture is identical. Without a progress check this
 * flings the whole 12-pass budget; with it, the loop gives up after two and says why.
 */
test('a vertical scroll that moves nothing gives up early instead of spending the full budget', async () => {
  let scrolls = 0;
  await assert.rejects(
    () =>
      run({
        // Same tree every pass: the Email row is below the fold (hidden content below → keeps
        // scrolling), never becomes visible, and nothing on screen shifts between captures.
        captures: [capture({ nodes: tree(2400) })],
        onScroll: () => (scrolls += 1),
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'scroll_until_no_progress');
      assert.equal(error.details?.passes, 3);
      assert.match(String(error.details?.hint), /not reaching this container/);
      return true;
    },
  );
  assert.equal(scrolls, 3);
});

test('running out of content stops before the pass budget does', async () => {
  let scrolls = 0;
  await assert.rejects(
    () =>
      run({
        // The row is on screen, so nothing is hidden below and the selector matches nothing.
        captures: [capture({ nodes: tree(200, 'Other') })],
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
        capture: async () => capture({ nodes: tree(200) }),
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
        capture: async () => capture({ nodes: tree(200) }),
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
  for (const frame of [capture({}), capture({ nodes: [] })]) {
    let scrolls = 0;
    await assert.rejects(
      () => run({ captures: [frame], onScroll: () => (scrolls += 1) }),
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
 * A tree the backend calls sparse is one whose selectors are not trustworthy, so it cannot answer
 * the question either way. It carries content below the fold, so an edge verdict would be wrong too.
 */
test('a sparse capture is refused before matching, edge analysis or scrolling', async () => {
  let scrolls = 0;
  await assert.rejects(
    () =>
      run({
        captures: [capture({ nodes: tree(2400), quality: SPARSE })],
        onScroll: () => (scrolls += 1),
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'scroll_until_capture_unreadable');
      assert.equal(error.details?.captureRefusal, 'sparse-tree');
      assert.match(String(error.message), /AX bridge unavailable/);
      return true;
    },
  );
  assert.equal(scrolls, 0);
});

test('the legacy iOS application-root-only shape is refused', async () => {
  await assert.rejects(
    () =>
      run({
        captures: [
          capture({
            backend: 'xctest',
            nodes: [{ index: 0, ref: 'e1', type: 'Application', rect: VIEWPORT } as SnapshotNode],
          }),
        ],
      }),
    (error: unknown) =>
      error instanceof AppError && error.details?.captureRefusal === 'sparse-tree',
  );
});

/**
 * A tree the backend vouches for is readable, and so is one whose tail was truncated: truncation
 * drops content, it does not make the capture untrustworthy.
 */
test('a populated capture is not refused, healthy or recovered', async () => {
  for (const state of ['healthy', 'recovered'] as const) {
    const result = await run({
      captures: [capture({ nodes: tree(200), quality: { state, backend: 'tree' } })],
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
