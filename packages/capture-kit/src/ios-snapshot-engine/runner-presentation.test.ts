import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type {
  IosSnapshotInput,
  IosSnapshotRequest,
  IosSnapshotValidationFacts,
} from '@agent-device/contracts/ios-snapshot';
import {
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { presentIosSnapshot } from './index.ts';
import {
  frameChangeIndicatorNodes,
  hostRowNodes,
  nestedScrollIndicatorNodes,
  runnerNodes,
  safariWebViewNodes,
  threadNodes,
  viewport,
} from './runner-presentation-fixtures.ts';

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
