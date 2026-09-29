import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';

export const viewport: Rect = { x: 0, y: 0, width: 402, height: 874 };

export function runnerNodes(): RawSnapshotNode[] {
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
export function threadNodes(): RawSnapshotNode[] {
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
export function hostRowNodes(hostType: string): RawSnapshotNode[] {
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
export function nestedScrollIndicatorNodes(): RawSnapshotNode[] {
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
export function frameChangeIndicatorNodes(): RawSnapshotNode[] {
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
export function safariWebViewNodes(): RawSnapshotNode[] {
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
