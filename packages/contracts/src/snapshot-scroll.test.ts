import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatRole } from '@agent-device/kernel/snapshot';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import { isScrollableNodeLike, isScrollableType } from './snapshot-scroll.ts';

function node(input: RawSnapshotNode): SnapshotNode {
  return { ...input, ref: `@e${input.index}`, kind: formatRole(input.type ?? 'Element') };
}

test('snapshot scroll semantics classify scrollable types and node-like roles', () => {
  const scrollView = node({ index: 1, type: 'ScrollView', parentIndex: 0 });

  assert.equal(isScrollableType('android.widget.RecyclerView'), true);
  assert.equal(isScrollableType('collection'), true);
  assert.equal(isScrollableType('collectionitem'), false);
  assert.equal(isScrollableNodeLike(scrollView), true);
});

/**
 * The names the iOS producers publish for an element type. A scroll bar names the indicator riding
 * beside scrollable content, so it holds no content a scroll moves: the runner publishes the name
 * now, and the fragment match below read the 3pt bar as its own container (#4657). The check is the
 * same one a bridge or Linux capture already met, because both spellings — the producer's `ScrollBar`
 * and UIKit's `_UIScrollViewScrollIndicator` — name the indicator.
 */
test.for(['ScrollBar', 'scrollindicator', 'AXScrollBar', 'collectionitem', 'Element(47)', 'Other'])(
  'the scroll indicator %s is not a scroll container',
  (type) => {
    assert.equal(isScrollableType(type), false);
  },
);

test.for([
  { type: 'ScrollBar', role: 'ScrollBar' },
  { type: 'Other', role: 'UIScrollViewScrollIndicator' },
  { type: 'Other', role: 'AXScrollBar' },
  { type: 'Other', role: '', subrole: 'AXScrollBar' },
])('the scroll indicator node %j is not a scroll container', (node) => {
  assert.equal(isScrollableNodeLike(node), false);
});

test.for([
  'ScrollView',
  'ScrollArea',
  'Table',
  'CollectionView',
  'android.widget.ScrollView',
  'androidx.recyclerview.widget.RecyclerView',
  'com.facebook.react.views.scroll.ReactScrollView',
])('the scroll container %s stays scrollable', (type) => {
  assert.equal(isScrollableType(type), true);
  assert.equal(isScrollableNodeLike({ type }), true);
});
