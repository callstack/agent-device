import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  IosSnapshotInput,
  IosSnapshotRequest,
  IosSnapshotValidationFacts,
} from '@agent-device/contracts/ios-snapshot';
import {
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { presentIosSnapshot } from './index.ts';

const viewport: Rect = { x: 0, y: 0, width: 402, height: 874 };

test('runner presentation clips rows to a scroll viewport derived from its indicator', () => {
  const request = createIosSnapshotRequest({ interactiveOnly: true });
  const nodes = runnerNodes();
  const result = presentIosSnapshot(runnerInput(request, nodes), request);
  const screenTime = result.nodes.find((node) => node.label === 'Screen Time');

  assert.deepEqual(screenTime?.rect, {
    x: 16,
    y: 796.3333333333334,
    width: 370,
    height: 15.666666666666629,
  });
  assert.equal(screenTime?.hittable, true);
  assert.equal(
    result.nodes.some((node) => node.label === 'Offscreen'),
    false,
  );
});

test('a text view scroll indicator inside a list does not clip the list to that text', () => {
  const request = createIosSnapshotRequest({ interactiveOnly: true });
  const result = presentIosSnapshot(runnerInput(request, threadNodes()), request);
  const labels = result.nodes.map((node) => node.label);

  assert.deepEqual(result.nodes.find((node) => node.type === 'ScrollView')?.rect, {
    x: 0,
    y: 110,
    width: 402,
    height: 702,
  });
  assert.ok(labels.includes('Reply (58 replies)'));
  assert.ok(labels.includes('Reply 37'));
  assert.ok(labels.includes('Like (0 likes)'));
  assert.equal(
    labels.some((label) => label === 'Vertical scroll bar, 1 page'),
    false,
  );
  // Source-level membership: the text view's indicator (source index 5) owns nothing.
  assert.deepEqual(result.presentedIndexesBySourceIndex.get(5), []);
  assert.ok((result.presentedIndexesBySourceIndex.get(6) ?? []).length > 0);
});

// #2214 was patched for `TextView` alone (#2740); ADR 0026 generalises the rule to the parent edge,
// so every scroll-shaped host that publishes as a non-scroll type keeps its own indicator. A
// `WKWebView` (a UIScrollView underneath) and a paged `Cell` both reopen the class on `origin/main`:
// the ancestor walk skips the non-scroll host and clips the enclosing list to the host's one-line
// band. These cases are red before the parent-edge change and green after it.
for (const hostType of ['WebView', 'Cell']) {
  test(`a ${hostType} row's own scroll indicator does not clip the enclosing list`, () => {
    const request = createIosSnapshotRequest({ interactiveOnly: true });
    const result = presentIosSnapshot(runnerInput(request, hostRowNodes(hostType)), request);
    const labels = result.nodes.map((node) => node.label);

    assert.deepEqual(result.nodes.find((node) => node.type === 'ScrollView')?.rect, {
      x: 0,
      y: 110,
      width: 402,
      height: 702,
    });
    assert.ok(labels.includes('Reply (58 replies)'));
    assert.ok(labels.includes('Reply 37'));
    assert.ok(labels.includes('Like (0 likes)'));
    assert.equal(
      labels.some((label) => label === 'Vertical scroll bar, 1 page'),
      false,
    );
    // Source-level membership: the host's indicator (source index 4) presents no representative, so it
    // owns nothing, while every row below the host (indices 5-7) keeps one. On `origin/main` the
    // indicator is attributed to the list, so index 4 would map to the list's representative instead.
    assert.deepEqual(result.presentedIndexesBySourceIndex.get(4), []);
    for (const rowSourceIndex of [5, 6, 7]) {
      assert.ok(
        (result.presentedIndexesBySourceIndex.get(rowSourceIndex) ?? []).length > 0,
        `row source index ${rowSourceIndex} must survive`,
      );
    }
  });
}

// A scroll-typed node that carries an indicator label describes itself, not its parent. It must own
// nothing: banding its parent would clip a sibling list to the host's band, mirroring #2214 upward.
test('a scroll-typed node labelled as an indicator does not band its parent list', () => {
  const request = createIosSnapshotRequest({ interactiveOnly: true });
  const result = presentIosSnapshot(runnerInput(request, nestedScrollIndicatorNodes()), request);
  const labels = result.nodes.map((node) => node.label);

  assert.deepEqual(result.nodes.find((node) => node.type === 'Table')?.rect, {
    x: 0,
    y: 116,
    width: 402,
    height: 696,
  });
  assert.ok(labels.includes('Row low'));
});

// The pass-through stops at the first frame change (ADR 0026). A wrapper that fills the scroll view is
// a transparent part of that one scroll region, but a smaller wrapper is a different scroll region.
// Here the walk climbs `Wrapper` → `Scroller` (same frame) and then hits a smaller sibling — so the
// indicator below the frame change resolves no owner and the list keeps its full extent, rather than
// banding `Scroller` to the smaller wrapper's sub-region.
test('a frame change stops the pass-through so a sub-region indicator owns nothing', () => {
  const request = createIosSnapshotRequest({ interactiveOnly: true });
  const result = presentIosSnapshot(runnerInput(request, frameChangeIndicatorNodes()), request);
  const scrollView = result.nodes.find((node) => node.type === 'ScrollView');
  const labels = result.nodes.map((node) => node.label);

  assert.deepEqual(scrollView?.rect, { x: 0, y: 110, width: 402, height: 764 });
  assert.equal(scrollView?.hiddenContentBelow, undefined);
  assert.ok(labels.includes('Row below'));
  assert.deepEqual(result.presentedIndexesBySourceIndex.get(4), []);
});

// Reduced from a real `snapshot -i --raw` capture of a WKWebView page in Safari (survey, #2754 step
// 3): the page scroller is `ScrollView` → `Other` → `WebView` → `WebView`, all one frame
// {0,0,402,874}, and the page's indicator ("Vertical scroll bar, 6 pages", {369,62,30,750}) is
// published under the inner `WebView`. Because those ancestors share the scroller's exact frame,
// ownership passes up to the `ScrollView`, so the page clips to the visible band {0,62,402,750} with
// `History` scrolled below it — the same output `origin/main` produces, confirmed byte-for-byte on the
// full capture. This is the leak #1784/#1797 under strict parent-edge ownership; the frame
// pass-through is the tolerance, and here the host fills the scroller, so it is the scroller's own
// region rather than a nested one (the `WebView`-row case above stays owned by nothing).
test('a WKWebView page whose web hosts fill the scroller clips to the page band', () => {
  const request = createIosSnapshotRequest({ interactiveOnly: true });
  const result = presentIosSnapshot(runnerInput(request, safariWebViewNodes()), request);
  const scrollView = result.nodes.find((node) => node.type === 'ScrollView');
  const labels = result.nodes.map((node) => node.label);

  assert.deepEqual(scrollView?.rect, { x: 0, y: 62, width: 402, height: 750 });
  assert.equal(scrollView?.hiddenContentBelow, true);
  assert.equal(labels.includes('History'), false);
});

function runnerInput(request: IosSnapshotRequest, nodes: RawSnapshotNode[]): IosSnapshotInput {
  return {
    stage: 'presented',
    presentation: {
      producer: 'apple-runner',
      intent: 'full',
      payload: { nodes, truncated: false },
    },
    validation: validationFacts(request),
  };
}

function validationFacts(request: IosSnapshotRequest): IosSnapshotValidationFacts {
  return {
    presentationKey: buildIosSnapshotPresentationKey(request),
    viewport: { kind: 'reported', rect: viewport },
    hittability: { kind: 'available' },
    lineage: { targetId: 'runner-target', generation: 'runner-generation' },
    residue: [],
  };
}

function runnerNodes(): RawSnapshotNode[] {
  return [
    runnerNode(0, 'Application', 'Settings', viewport),
    runnerNode(1, 'Other', undefined, viewport, 0, 1),
    runnerNode(2, 'CollectionView', 'Settings', viewport, 1, 2),
    runnerNode(
      3,
      'Cell',
      'Screen Time',
      { x: 16, y: 796.3333333333334, width: 370, height: 52 },
      2,
      3,
    ),
    runnerNode(
      4,
      'Other',
      'Screen Time',
      { x: 16, y: 796.3333333333334, width: 370, height: 52 },
      3,
      4,
    ),
    runnerNode(
      5,
      'Button',
      'Screen Time',
      { x: 16, y: 796.3333333333334, width: 370, height: 52 },
      4,
      5,
    ),
    runnerNode(
      6,
      'StaticText',
      'Screen Time',
      { x: 30, y: 808.3333, width: 137.3333, height: 28 },
      5,
      6,
    ),
    runnerNode(7, 'Image', undefined, { x: 30, y: 808.3333333333334, width: 28, height: 28 }, 5, 6),
    runnerNode(8, 'Cell', 'Offscreen', { x: 16, y: 820, width: 370, height: 52 }, 2, 3),
    runnerNode(9, 'Button', 'Offscreen', { x: 16, y: 820, width: 370, height: 52 }, 8, 4),
    {
      ...runnerNode(
        10,
        'Other',
        'Vertical scroll bar, 2 pages',
        {
          x: 369,
          y: 116,
          width: 30,
          height: 696,
        },
        2,
        3,
      ),
      value: '0%',
    },
  ];
}

/**
 * A post thread as XCTest reports it: the list's own indicator is its child, while the root post's
 * selectable text is a `TextView` (a UIScrollView underneath) carrying an indicator of its own.
 */
function threadNodes(): RawSnapshotNode[] {
  const rowRect = { x: 16, y: 180, width: 370, height: 22 };
  return [
    runnerNode(0, 'Application', 'Blue Sky', viewport),
    runnerNode(
      1,
      'ScrollView',
      'Vertical scroll bar, 5 pages',
      { x: 0, y: 110, width: 402, height: 764 },
      0,
      1,
    ),
    runnerNode(2, 'Other', 'Bob', { x: 0, y: 110, width: 402, height: 764 }, 1, 2),
    runnerNode(3, 'Other', 'Thread root', rowRect, 2, 3),
    runnerNode(4, 'TextView', 'Thread root', rowRect, 3, 4),
    {
      ...runnerNode(
        5,
        'Other',
        'Vertical scroll bar, 1 page',
        { x: 353, y: 180, width: 30, height: 22 },
        4,
        5,
      ),
      value: '0%',
    },
    runnerNode(6, 'Button', 'Reply (58 replies)', { x: 9, y: 232, width: 54, height: 32 }, 2, 3),
    runnerNode(7, 'Link', 'Reply 37', { x: 16, y: 274, width: 370, height: 165 }, 2, 3),
    runnerNode(8, 'Button', 'Like (0 likes)', { x: 209, y: 412, width: 28, height: 28 }, 7, 4),
    {
      ...runnerNode(
        9,
        'Other',
        'Vertical scroll bar, 5 pages',
        { x: 369, y: 110, width: 30, height: 702 },
        1,
        2,
      ),
      value: '0%',
    },
  ];
}

/**
 * A list whose row is a scroll-shaped host that publishes as a non-scroll type. The host carries an
 * indicator of its own (a one-page band over the row), while the list's own indicator reports the real
 * multi-page track. Correct ownership keeps the list's band and every row below the host.
 */
function hostRowNodes(hostType: string): RawSnapshotNode[] {
  const rowRect = { x: 16, y: 180, width: 370, height: 22 };
  return [
    runnerNode(0, 'Application', 'Reader', viewport),
    runnerNode(
      1,
      'ScrollView',
      'Vertical scroll bar, 3 pages',
      { x: 0, y: 110, width: 402, height: 764 },
      0,
      1,
    ),
    runnerNode(2, 'Other', 'Article', { x: 0, y: 110, width: 402, height: 764 }, 1, 2),
    runnerNode(3, hostType, 'Page', rowRect, 2, 3),
    {
      ...runnerNode(
        4,
        'Other',
        'Vertical scroll bar, 1 page',
        { x: 353, y: 180, width: 30, height: 22 },
        3,
        4,
      ),
      value: '0%',
    },
    runnerNode(5, 'Button', 'Reply (58 replies)', { x: 9, y: 232, width: 54, height: 32 }, 2, 3),
    runnerNode(6, 'Link', 'Reply 37', { x: 16, y: 274, width: 370, height: 165 }, 2, 3),
    runnerNode(7, 'Button', 'Like (0 likes)', { x: 209, y: 412, width: 28, height: 28 }, 6, 4),
    {
      ...runnerNode(
        8,
        'Other',
        'Vertical scroll bar, 3 pages',
        { x: 369, y: 110, width: 30, height: 702 },
        1,
        2,
      ),
      value: '0%',
    },
  ];
}

/**
 * A list that holds a nested scroll host (a `ScrollView`) which itself carries a scroll-bar label and
 * a percent value. That node describes itself, so it owns nothing; the list's real multi-page band
 * comes from its own indicator, keeping `Row low`.
 */
function nestedScrollIndicatorNodes(): RawSnapshotNode[] {
  return [
    runnerNode(0, 'Application', 'Reader', viewport),
    runnerNode(1, 'Table', 'Feed', { x: 0, y: 40, width: 402, height: 800 }, 0, 1),
    {
      ...runnerNode(
        2,
        'ScrollView',
        'Vertical scroll bar, 2 pages',
        { x: 0, y: 300, width: 402, height: 40 },
        1,
        2,
      ),
      value: '50%',
    },
    runnerNode(3, 'Button', 'Row high', { x: 16, y: 60, width: 370, height: 40 }, 1, 2),
    runnerNode(4, 'Button', 'Row low', { x: 16, y: 700, width: 370, height: 40 }, 1, 2),
    {
      ...runnerNode(
        5,
        'Other',
        'Vertical scroll bar, 3 pages',
        { x: 369, y: 116, width: 30, height: 696 },
        1,
        2,
      ),
      value: '0%',
    },
  ];
}

/**
 * A list (`ScrollView`, {0,110,402,764}) holding a smaller `Card` sub-region ({0,300,402,400}) that
 * nests an `Inner` wrapper of the same sub-frame and the indicator. The walk climbs `Inner` → `Card`
 * (same frame) but then hits the frame change against `ScrollView`, so the indicator resolves no owner
 * and `ScrollView` keeps its full extent — the frame change, not a label, is what stops ownership.
 */
function frameChangeIndicatorNodes(): RawSnapshotNode[] {
  return [
    runnerNode(0, 'Application', 'Reader', viewport),
    runnerNode(1, 'ScrollView', 'Feed', { x: 0, y: 110, width: 402, height: 764 }, 0, 1),
    runnerNode(2, 'Other', 'Card', { x: 0, y: 300, width: 402, height: 400 }, 1, 2),
    runnerNode(3, 'Other', 'Inner', { x: 0, y: 300, width: 402, height: 400 }, 2, 3),
    {
      ...runnerNode(
        4,
        'Other',
        'Vertical scroll bar, 3 pages',
        { x: 369, y: 300, width: 30, height: 400 },
        3,
        4,
      ),
      value: '0%',
    },
    runnerNode(5, 'Button', 'Row above', { x: 16, y: 120, width: 370, height: 40 }, 1, 2),
    runnerNode(6, 'Button', 'Row below', { x: 16, y: 800, width: 370, height: 40 }, 1, 2),
  ];
}

/**
 * Reduced from a real Safari `snapshot -i --raw` capture (indices mirror the live tree): the page
 * scroller `ScrollView` holds an `Other` → `WebView` → `WebView` chain, and the page's indicator is
 * published under the inner `WebView`. A link sits below where the walk-derived band would land.
 */
function safariWebViewNodes(): RawSnapshotNode[] {
  return [
    runnerNode(0, 'Application', 'Safari', viewport),
    runnerNode(1, 'ScrollView', 'iOS - Wikipedia', { x: 0, y: 0, width: 402, height: 874 }, 0, 1),
    runnerNode(2, 'Other', undefined, { x: 0, y: 0, width: 402, height: 874 }, 1, 2),
    runnerNode(3, 'WebView', undefined, { x: 0, y: 0, width: 402, height: 874 }, 2, 3),
    runnerNode(4, 'WebView', undefined, { x: 0, y: 0, width: 402, height: 874 }, 3, 4),
    {
      ...runnerNode(
        5,
        'Other',
        'Vertical scroll bar, 6 pages',
        { x: 369, y: 62, width: 30, height: 750 },
        4,
        5,
      ),
      value: '0%',
    },
    runnerNode(6, 'Link', 'History', { x: 16, y: 820, width: 370, height: 28 }, 1, 2),
  ];
}

function runnerNode(
  index: number,
  type: string,
  label: string | undefined,
  rect: Rect,
  parentIndex?: number,
  depth = parentIndex === undefined ? 0 : 1,
): RawSnapshotNode {
  return {
    index,
    type,
    ...(label ? { label } : {}),
    rect,
    enabled: true,
    hittable: true,
    depth,
    ...(parentIndex === undefined ? {} : { parentIndex }),
  };
}
