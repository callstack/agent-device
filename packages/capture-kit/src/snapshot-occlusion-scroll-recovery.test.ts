import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { annotateCoveredSnapshotNodes } from './snapshot-occlusion.ts';

test.each([
  {
    name: 'a horizontal viewport wholly contained by a bottom bar',
    scrollerType: 'HorizontalScrollView',
    scrollerRect: { x: 0, y: 725, width: 400, height: 65 },
    barRect: { x: 0, y: 725, width: 400, height: 75 },
    expected: undefined,
  },
  {
    name: 'a viewport contained by a bar after clipping to the screen',
    scrollerType: 'ScrollView',
    scrollerRect: { x: 0, y: 730, width: 400, height: 150 },
    barRect: { x: 0, y: 725, width: 400, height: 75 },
    expected: undefined,
  },
  {
    name: 'a horizontal tap path entirely behind a full-width bar',
    scrollerType: 'HorizontalScrollView',
    scrollerRect: { x: 0, y: 700, width: 400, height: 100 },
    barRect: { x: 0, y: 725, width: 400, height: 75 },
    expected: undefined,
  },
  {
    name: 'an iOS scroll view with unknown axis behind a tab bar',
    scrollerType: 'ScrollView',
    barType: 'TabBar',
    scrollerRect: { x: 0, y: 700, width: 400, height: 100 },
    barRect: { x: 0, y: 725, width: 400, height: 75 },
    expected: undefined,
  },
  {
    name: 'an iOS scroll view with hidden content below a tab bar',
    scrollerType: 'ScrollView',
    barType: 'TabBar',
    hiddenContentBelow: true,
    scrollerRect: { x: 0, y: 700, width: 400, height: 100 },
    barRect: { x: 0, y: 725, width: 400, height: 75 },
    expected: true,
  },
  {
    name: 'an iOS scroll view with hidden content only above a tab bar',
    scrollerType: 'ScrollView',
    barType: 'TabBar',
    hiddenContentAbove: true,
    scrollerRect: { x: 0, y: 700, width: 400, height: 100 },
    barRect: { x: 0, y: 725, width: 400, height: 75 },
    expected: undefined,
  },
  {
    name: 'a horizontal tap path that extends past the bar',
    scrollerType: 'HorizontalScrollView',
    scrollerRect: { x: 0, y: 700, width: 400, height: 100 },
    barRect: { x: 300, y: 700, width: 100, height: 100 },
    expected: true,
  },
  {
    name: 'a vertical tap path that extends above the bar',
    scrollerType: 'VerticalScrollView',
    scrollerRect: { x: 0, y: 700, width: 400, height: 100 },
    barRect: { x: 0, y: 725, width: 400, height: 75 },
    expected: true,
  },
])(
  'reports scroll recovery for $name',
  ({
    scrollerType,
    barType,
    hiddenContentAbove,
    hiddenContentBelow,
    scrollerRect,
    barRect,
    expected,
  }) => {
    const nodes: RawSnapshotNode[] = [
      { index: 0, type: 'Window', rect: { x: 0, y: 0, width: 400, height: 800 } },
      {
        index: 1,
        parentIndex: 0,
        type: barType ? scrollerType : `android.widget.${scrollerType}`,
        rect: scrollerRect,
        hiddenContentAbove,
        hiddenContentBelow,
      },
      {
        index: 2,
        parentIndex: 1,
        type: 'Button',
        hittable: true,
        label: 'Buy',
        rect: { x: 320, y: 740, width: 60, height: 40 },
      },
      {
        index: 3,
        parentIndex: 0,
        type: barType ?? 'com.google.android.material.bottomnavigation.BottomNavigationView',
        rect: barRect,
      },
    ];

    const target = annotateCoveredSnapshotNodes(nodes)[2];
    assert.equal(target?.interactionBlocked, 'covered');
    assert.equal(target?.coveredBy?.persistentBar, true);
    assert.equal(target?.coveredBy?.scrollCanReveal, expected);
  },
);
