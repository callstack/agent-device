import { describe, expect, test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { resolveMaestroScrollableGesture } from '../runtime-port-geometry.ts';
// The snapshot-facing platform union ('android' | 'ios'), not program-ir's,
// which also carries 'web'.
import type { MaestroPlatform } from '../runtime-target-policy.ts';
import { isMaestroNodeVisible } from '../snapshot-policy.ts';

// Maestro asks two questions about a scrollable node, and they must agree:
//
//   clips  - which ancestor bounds a node, deciding whether it counts as visible
//   swipes - which container scrollUntilVisible starts its swipe inside
//
// Both now go through contracts' isScrollableNodeLike. This table pins the
// classification against the vocabulary each platform actually emits:
// `elementTypeName` in RunnerTests+Snapshot.swift for iOS (short PascalCase
// names, NOT XCUIElementType*), and the fully-qualified `className` from the
// Android view hierarchy. The Android rows are the regression guard: the swipe
// side used to equality-match a normalized type, so it recognized bare
// ScrollView and silently missed every other Android scroll container.

const APPLICATION: SnapshotNode = {
  index: 0,
  ref: '@e1',
  type: 'Application',
  visibleToUser: true,
  rect: { x: 0, y: 0, width: 402, height: 874 },
};

// Tall and narrow so the vertical-axis check in selectMaestroScrollableViewport
// accepts it, and short enough that the target below sits outside it.
const CONTAINER_RECT = { x: 0, y: 100, width: 200, height: 600 };
const TARGET_RECT = { x: 20, y: 750, width: 100, height: 40 };

function snapshotWithContainer(containerType: string) {
  const nodes: SnapshotNode[] = [
    APPLICATION,
    {
      index: 1,
      ref: '@e2',
      parentIndex: 0,
      type: containerType,
      visibleToUser: true,
      rect: CONTAINER_RECT,
    },
    {
      index: 2,
      ref: '@e3',
      parentIndex: 1,
      type: 'Button',
      identifier: 'target',
      visibleToUser: true,
      rect: TARGET_RECT,
    },
  ];
  return { createdAt: 0, nodes };
}

/** True when the container clips the target, i.e. it is the effective viewport. */
function clips(containerType: string, platform: MaestroPlatform): boolean {
  const { nodes } = snapshotWithContainer(containerType);
  // The target sits outside the container rect but inside the Application rect,
  // so it reads as hidden exactly when the container is the viewport.
  return !isMaestroNodeVisible(nodes[2]!, nodes, platform);
}

/** True when scrollUntilVisible swipes inside the container instead of the screen. */
function swipes(containerType: string, platform: MaestroPlatform): boolean {
  const gesture = resolveMaestroScrollableGesture(
    snapshotWithContainer(containerType),
    { id: 'target' },
    'down',
    600,
    platform,
  );
  // No container selected => daemon-runtime-port.ts falls back to a plain
  // screen scroll.
  if (!gesture) return false;
  expect(gesture.viewport).toEqual(CONTAINER_RECT);
  return true;
}

// Every name `elementTypeName` can return. Scroll containers per the runner's
// own `scrollContainerTypes` set: collectionView, scrollView, table.
const IOS_VOCABULARY: ReadonlyArray<[string, boolean]> = [
  ['Application', false],
  ['Window', false],
  ['Button', false],
  ['Cell', false],
  ['StaticText', false],
  ['TextField', false],
  ['TextView', false],
  ['SecureTextField', false],
  ['Switch', false],
  ['Slider', false],
  ['Link', false],
  ['Image', false],
  ['NavigationBar', false],
  ['TabBar', false],
  ['CollectionView', true],
  ['Table', true],
  ['ScrollView', true],
  ['Toolbar', false],
  ['SearchField', false],
  ['SegmentedControl', false],
  ['Stepper', false],
  ['Picker', false],
  ['ActivityIndicator', false],
  ['ProgressIndicator', false],
  ['CheckBox', false],
  ['MenuItem', false],
  ['WebView', false],
  ['Other', false],
  ['Keyboard', false],
  ['Key', false],
  ['Element(42)', false],
];

describe('iOS: both walks agree across the runner vocabulary', () => {
  test.each(IOS_VOCABULARY)('%s is a scroll container: %s', (type, scrollable) => {
    expect(clips(type, 'ios')).toBe(scrollable);
    expect(swipes(type, 'ios')).toBe(scrollable);
  });
});

// Fully-qualified class names, as `attrs.className` delivers them.
const ANDROID_VOCABULARY: ReadonlyArray<[string, boolean]> = [
  ['android.widget.ScrollView', true],
  // These five were classified as clipping but NOT as swipe containers before
  // the predicates were unified, so scrollUntilVisible fell back to a
  // screen-centred swipe inside every RecyclerView-backed list.
  ['android.widget.HorizontalScrollView', true],
  ['androidx.core.widget.NestedScrollView', true],
  ['androidx.recyclerview.widget.RecyclerView', true],
  ['android.widget.ListView', true],
  ['android.widget.GridView', true],
  ['android.widget.LinearLayout', false],
  ['android.widget.FrameLayout', false],
  ['android.view.View', false],
  ['android.widget.Button', false],
  ['androidx.compose.ui.platform.ComposeView', false],
];

describe('Android: both walks agree across common view classes', () => {
  test.each(ANDROID_VOCABULARY)('%s is a scroll container: %s', (type, scrollable) => {
    expect(clips(type, 'android')).toBe(scrollable);
    expect(swipes(type, 'android')).toBe(scrollable);
  });
});

test('a RecyclerView is selected as the swipe viewport, not the whole screen', () => {
  const gesture = resolveMaestroScrollableGesture(
    snapshotWithContainer('androidx.recyclerview.widget.RecyclerView'),
    { id: 'target' },
    'down',
    600,
    'android',
  );
  // Regression: this was `undefined` (screen-centred swipe) before the fix.
  expect(gesture?.viewport).toEqual(CONTAINER_RECT);
  // The swipe starts inside the list, at the container's centre.
  expect(gesture?.gesture.from).toEqual({ x: 100, y: 400 });
});
