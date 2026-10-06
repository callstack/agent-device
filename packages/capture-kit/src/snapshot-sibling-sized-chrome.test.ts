import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { annotateCoveredSnapshotNodes } from './snapshot-occlusion.ts';

// The sibling-sized-chrome family of `snapshot-occlusion.test.ts`: every test here drives the rule
// through `annotateCoveredSnapshotNodes`, which owns it as a private classification step. The rule
// stays inside that module because the eager-closure gate (#1739, ADR-0019) forbids a new module in
// the closure of a published entry surface, and `snapshot-occlusion.ts` is one.
//
// #2996: on iOS 26/27 UIKit hosts a bottom tab bar in a `_UIFloatingBarContainerView` (published as
// `type: 'Toolbar'`) that is a SIBLING of the tab screen's content branch under the same layout
// container, sized to that branch's frame. The reporter's capture shows `0,0,402,791` beside a
// `0,0,402,791` content branch with the 83pt tab bar at y=791 outside both; the two "live shape"
// tests carry trees captured on an iPhone 18 Pro (iOS 27.0). The container reports `hittable: true`
// and passes touches through, so `press`/`fill` refused every element above the tab bar while a
// coordinate press at the same point worked. The existing `isFullViewportChromeContainer` exemption
// compares the candidate against the viewport root, and such a container deliberately stops short
// of it, so the sibling-level rule owns this case.

type NodeSpec = {
  index: number;
  parentIndex?: number;
  depth: number;
  type: string;
  role?: string;
  subrole?: string;
  label?: string;
  rect: Rect;
  hittable?: boolean;
};

const VIEWPORT: Rect = { x: 0, y: 0, width: 402, height: 874 };
const BRANCH: Rect = { x: 0, y: 0, width: 402, height: 791 };
const TARGET: Rect = { x: 151, y: 74, width: 100, height: 32 };
/** A chrome container 60pt short of the branch: matches neither the sibling nor the viewport. */
const SHORTER_CHROME: Rect = { x: 0, y: 0, width: 402, height: 731 };

function node(spec: NodeSpec): RawSnapshotNode {
  return {
    index: spec.index,
    ...(spec.parentIndex === undefined ? {} : { parentIndex: spec.parentIndex }),
    depth: spec.depth,
    type: spec.type,
    ...(spec.role === undefined ? {} : { role: spec.role }),
    ...(spec.subrole === undefined ? {} : { subrole: spec.subrole }),
    ...(spec.label === undefined ? {} : { label: spec.label }),
    rect: spec.rect,
    ...(spec.hittable === undefined ? {} : { hittable: spec.hittable }),
  };
}

type ChromeHostDeltas = {
  /** Frame of the `Toolbar`-typed container listed beside the content branch. */
  chromeRect?: Rect;
  /** UIKit class published in `role` beside `type: 'Toolbar'`; omit for the runner shape. */
  chromeRole?: string;
  /** AX subrole carrying the kind, for the publication that names neither type nor role. */
  chromeSubrole?: string;
  /** Frame of the content branch; the chrome container's default is to match it. */
  branchRect?: Rect;
  /** Frame of the target button inside the content branch. */
  targetRect?: Rect;
  /** Container kind and role; defaults to the chrome host from the captures. */
  chromeType?: string;
  chromeLabel?: string;
};

/**
 * Application > Window > layout container holding the content branch (with one button inside) and
 * the chrome container as listed siblings; `TARGET` sits inside the branch. The `chrome*` kind fields
 * cover each published iOS producer shape: the AX bridge names the UIKit class in `role` or `subrole`,
 * the runner leaves `type: 'Toolbar'` alone.
 */
function chromeHostTree(deltas: ChromeHostDeltas = {}): RawSnapshotNode[] {
  const branchRect = deltas.branchRect ?? BRANCH;
  const chromeRect = deltas.chromeRect ?? branchRect;
  const chrome: NodeSpec = {
    index: 5,
    parentIndex: 2,
    depth: 3,
    type: deltas.chromeType ?? 'Toolbar',
    ...(deltas.chromeRole === undefined ? {} : { role: deltas.chromeRole }),
    ...(deltas.chromeSubrole === undefined ? {} : { subrole: deltas.chromeSubrole }),
    label: deltas.chromeLabel ?? 'Toolbar',
    rect: chromeRect,
    hittable: true,
  };
  return [
    node({ index: 0, depth: 0, type: 'Application', role: 'UIApplication', rect: VIEWPORT }),
    node({
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      role: 'UIWindow',
      rect: VIEWPORT,
      hittable: true,
    }),
    node({
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      role: 'UILayoutContainerView',
      rect: VIEWPORT,
      hittable: true,
    }),
    node({
      index: 3,
      parentIndex: 2,
      depth: 3,
      type: 'Other',
      role: 'RCTRootContentView',
      rect: branchRect,
      hittable: true,
    }),
    node({
      index: 4,
      parentIndex: 3,
      depth: 4,
      type: 'Button',
      role: 'RCTButton',
      label: 'Add plant',
      rect: deltas.targetRect ?? TARGET,
      hittable: true,
    }),
    node(chrome),
  ];
}

function targetVerdict(nodes: RawSnapshotNode[]): RawSnapshotNode | undefined {
  return annotateCoveredSnapshotNodes(nodes).find((candidate) => candidate.index === 4);
}

test("a chrome container sized to its content sibling branch does not cover that branch's targets (#2996)", () => {
  // The reporter's capture: the container is 791pt tall, matching the content branch beside it and
  // stopping 83pt short of the 874pt viewport the existing exemption keys on. The four publications
  // of the chrome kind are pinned by the table below, so this pins the geometry and the target's own
  // readback.
  const annotated = targetVerdict(
    chromeHostTree({ branchRect: BRANCH, chromeRole: '_UIFloatingBarContainerView' }),
  );

  assert.equal(annotated?.interactionBlocked, undefined);
  assert.equal(annotated?.hittable, true);
});

test('a control the exempt container really hosts still covers what it overlaps (#2996)', () => {
  // The exemption excuses the container's OWN box, not its subtree: a hosted strip with its own
  // smaller rect is unrelated to the target and differs from the branch frame, so it keeps covering
  // the content beneath it — the fix cannot trade false refusals for missed real occlusion.
  const nodes = chromeHostTree({
    targetRect: { x: 151, y: 700, width: 100, height: 32 },
    chromeRole: '_UIFloatingBarContainerView',
  });
  nodes.push(
    node({
      index: 6,
      parentIndex: 5,
      depth: 4,
      type: 'Toolbar',
      role: '_UIBarPlatterView',
      label: 'Add',
      rect: { x: 140, y: 690, width: 120, height: 50 },
      hittable: true,
    }),
  );

  assert.equal(targetVerdict(nodes)?.interactionBlocked, 'covered');
});

test('a chrome candidate whose frame differs from the content branch beside it still covers (#2996 non-vacuity)', () => {
  // Isolates frame-EQUALITY from mere overlap: the container stops 60pt short of the branch, so it
  // matches neither the branch nor the viewport, and its box is real covering evidence over the
  // target in the region they share.
  const nodes = chromeHostTree({
    branchRect: BRANCH,
    chromeRect: { x: 0, y: 0, width: 402, height: 731 },
    chromeRole: '_UIFloatingBarContainerView',
  });

  assert.equal(targetVerdict(nodes)?.interactionBlocked, 'covered');
});

test('a chrome candidate taller than the content branch beside it still covers, so equality is not overlap (#2996 containment)', () => {
  // The mirror must be the SAME frame, not merely containing it. The container reaches 91pt below
  // the branch while stopping short of the viewport, so it paints over the branch's lower edge and
  // keeps covering the target inside that edge.
  const nodes = chromeHostTree({
    branchRect: { x: 0, y: 0, width: 402, height: 700 },
    chromeRect: BRANCH,
    targetRect: { x: 151, y: 640, width: 100, height: 32 },
    chromeRole: '_UIFloatingBarContainerView',
  });

  assert.equal(targetVerdict(nodes)?.interactionBlocked, 'covered');
});

test('a full-screen dialog sized to the content branch beside it still covers, because only chrome kinds are exempt (#2996 kind gate)', () => {
  // A `Dialog` sibling that fills the branch is a real modal presentation over that branch. Reading
  // the exemption from geometry alone would let it through, so it stays kind-gated.
  const nodes = chromeHostTree({
    chromeType: 'Dialog',
    chromeRole: 'UIAlertControllerView',
    chromeLabel: undefined,
  });

  assert.equal(targetVerdict(nodes)?.interactionBlocked, 'covered');
});

test('a chrome candidate in another window keeps covering content sized like its own frame (#2996 sibling scope)', () => {
  // The exemption compares a candidate against the siblings listed under ITS OWN parent. This
  // container's only sibling is its own full-window host, so nothing matches and it keeps covering
  // — a same-size rect elsewhere in the tree cannot excuse it.
  const nodes: RawSnapshotNode[] = [
    node({ index: 0, depth: 0, type: 'Application', role: 'UIApplication', rect: VIEWPORT }),
    node({
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      role: 'UIWindow',
      rect: VIEWPORT,
      hittable: true,
    }),
    node({
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      role: 'UILayoutContainerView',
      rect: BRANCH,
      hittable: true,
    }),
    node({
      index: 3,
      parentIndex: 2,
      depth: 3,
      type: 'Other',
      role: 'RCTRootContentView',
      rect: BRANCH,
      hittable: true,
    }),
    node({
      index: 4,
      parentIndex: 3,
      depth: 4,
      type: 'Button',
      role: 'RCTButton',
      label: 'Add plant',
      rect: TARGET,
      hittable: true,
    }),
    node({
      index: 5,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      role: 'UIWindow',
      rect: VIEWPORT,
      hittable: true,
    }),
    node({
      index: 6,
      parentIndex: 5,
      depth: 2,
      type: 'Toolbar',
      role: '_UIFloatingBarContainerView',
      label: 'Toolbar',
      rect: BRANCH,
      hittable: true,
    }),
  ];

  assert.equal(targetVerdict(nodes)?.interactionBlocked, 'covered');
});

test('the captured iOS 27 tab-bar host container stops condemning every tab (#2996 live shape)', () => {
  // Verbatim shape from `snapshot --raw` on an iPhone 18 Pro running a JS-tab app: a badge container
  // and a content view are listed beside each other under the platter with identical 360x62 frames,
  // and the badge container covered the tab buttons sitting inside its sibling.
  const platter: Rect = { x: 21, y: 791, width: 360, height: 62 };
  const nodes: RawSnapshotNode[] = [
    node({
      index: 128,
      parentIndex: 127,
      depth: 21,
      type: 'Other',
      role: '_UITouchPassthroughView',
      rect: VIEWPORT,
      hittable: true,
    }),
    node({
      index: 129,
      parentIndex: 128,
      depth: 22,
      type: 'Other',
      role: 'UIKit._UITabBarItemPlatterView',
      rect: platter,
      hittable: true,
    }),
    node({
      index: 131,
      parentIndex: 129,
      depth: 23,
      type: 'Other',
      role: '_TtCC5UIKit20_UITabBarPlatterViewContentView',
      rect: platter,
      hittable: true,
    }),
    node({
      index: 132,
      parentIndex: 131,
      depth: 24,
      type: 'Button',
      role: '_UITabButton',
      label: 'Home',
      rect: { x: 25, y: 795, width: 85.35, height: 54 },
      hittable: true,
    }),
    node({
      index: 142,
      parentIndex: 129,
      depth: 23,
      type: 'Other',
      role: '_TtCC5UIKit20_UITabBarPlatterViewBadgeContainerView',
      rect: platter,
      hittable: true,
    }),
  ];

  assert.equal(
    annotateCoveredSnapshotNodes(nodes).find((candidate) => candidate.label === 'Home')
      ?.interactionBlocked,
    undefined,
  );
});

test('the captured system-app bottom-bar container stops condemning the content and bar beside it (#2996 live shape)', () => {
  // Verbatim shape from `snapshot --raw` on a system app: a `Toolbar` published with the content
  // branch's 402x812 frame marked that branch's 36 nodes and the 402x54 navigation bar listed beside
  // it. The container paints nothing itself; its one child repeats its own frame.
  const contentArea: Rect = { x: 0, y: 62, width: 402, height: 812 };
  const nodes: RawSnapshotNode[] = [
    node({ index: 5, parentIndex: 4, depth: 5, type: 'Other', rect: contentArea, hittable: true }),
    node({ index: 6, parentIndex: 5, depth: 6, type: 'Other', rect: contentArea, hittable: true }),
    node({
      index: 7,
      parentIndex: 6,
      depth: 7,
      type: 'NavigationBar',
      label: 'Messages',
      rect: { x: 0, y: 78, width: 402, height: 54 },
      hittable: true,
    }),
    node({ index: 8, parentIndex: 6, depth: 7, type: 'Other', rect: contentArea, hittable: true }),
    node({
      index: 19,
      parentIndex: 8,
      depth: 8,
      type: 'Button',
      label: 'Continue',
      rect: { x: 131, y: 700, width: 140, height: 44 },
      hittable: true,
    }),
    node({
      index: 48,
      parentIndex: 6,
      depth: 7,
      type: 'Toolbar',
      label: 'Toolbar',
      rect: contentArea,
      hittable: true,
    }),
    node({
      index: 49,
      parentIndex: 48,
      depth: 8,
      type: 'Other',
      rect: contentArea,
      hittable: true,
    }),
  ];

  const annotated = annotateCoveredSnapshotNodes(nodes);
  assert.equal(
    annotated.find((candidate) => candidate.label === 'Continue')?.interactionBlocked,
    undefined,
  );
  assert.equal(
    annotated.find((candidate) => candidate.type === 'NavigationBar')?.interactionBlocked,
    undefined,
  );
});

type ChromeKindPublication = {
  name: string;
  chromeType: string;
  chromeRole?: string;
  chromeSubrole?: string;
};

// The iOS producers publish the same container three ways: the runner path leaves `type: 'Toolbar'`
// alone, the AX bridge names the UIKit class in `role`, and a subrole-only shape appears where the
// bridge publishes only the AX role. Each pair below pins both directions for one publication, so a
// kind read that stopped consulting a field would fail that publication's exemption case while its
// offset case stays `covered`.
const CHROME_KIND_PUBLICATIONS: ChromeKindPublication[] = [
  { name: 'type only (runner shape)', chromeType: 'Toolbar' },
  { name: 'UIKit class in role', chromeType: 'Toolbar', chromeRole: '_UIFloatingBarContainerView' },
  { name: 'class in role beside a generic type', chromeType: 'Other', chromeRole: 'UITabBar' },
  { name: 'subrole only', chromeType: 'Other', chromeSubrole: 'AXToolbar' },
];

test.for(CHROME_KIND_PUBLICATIONS)(
  'the exemption reads the chrome kind from the $name publication (#2996)',
  ({ chromeType, chromeRole, chromeSubrole }) => {
    const published = { chromeType, chromeRole, chromeSubrole };
    assert.equal(targetVerdict(chromeHostTree(published))?.interactionBlocked, undefined);

    // Non-vacuity for this publication: with the frame 60pt short of the branch it matches neither
    // the sibling nor the viewport, so the same node is ordinary covering chrome.
    assert.equal(
      targetVerdict(chromeHostTree({ ...published, chromeRect: SHORTER_CHROME }))
        ?.interactionBlocked,
      'covered',
    );
  },
);

type CapturedNode = [
  index: number,
  parentIndex: number | undefined,
  type: string,
  role: string,
  label: string | undefined,
  rect: [x: number, y: number, width: number, height: number],
];

/** Builds a tree from rows captured with `snapshot -i --json`, every node hittable as published. */
function capturedTree(rows: CapturedNode[]): RawSnapshotNode[] {
  const parentByIndex = new Map(rows.map(([index, parentIndex]) => [index, parentIndex]));
  const depthOf = (index: number | undefined): number => {
    const parentIndex = index === undefined ? undefined : parentByIndex.get(index);
    return parentIndex === undefined ? 0 : depthOf(parentIndex) + 1;
  };
  return rows.map(([index, parentIndex, type, role, label, [x, y, width, height]]) => {
    const depth = depthOf(index);
    return node({
      index,
      parentIndex,
      depth,
      type,
      role,
      label,
      rect: { x, y, width, height },
      hittable: true,
    });
  });
}

/** Labels (or types, for unlabelled nodes) the occlusion pass marks covered, in tree order. */
function coveredLabels(nodes: RawSnapshotNode[]): string[] {
  return annotateCoveredSnapshotNodes(nodes)
    .filter((candidate) => candidate.interactionBlocked === 'covered')
    .map((candidate) => candidate.label ?? candidate.type ?? '');
}

test('the captured iOS 27 SwiftUI sheet toolbar host stops condemning the sheet in the interactive projection', () => {
  // `snapshot -i` of a `.medium` SwiftUI sheet on an iOS 27 simulator. Pruning dropped the wrappers
  // sharing the host's frame and the list's frame was rewritten to its scroll-indicator band, so no
  // sibling matches the host's 386x451 frame; it encloses the navigation bar and the list beside it.
  const nodes = capturedTree([
    [0, undefined, 'Other', 'SwiftUIApplication', 'SheetRepro', [0, 0, 402, 874]],
    [2, 0, 'Button', '_UIGrabber', 'Sheet Grabber', [152.99, 411.19, 96.02, 23.04]],
    [3, 0, 'NavigationBar', 'SwiftUI.UIKitNavigationBar', undefined, [8, 430.39, 386, 101.78]],
    [4, 3, 'Button', 'SwiftUI.AccessibilityNode', 'Close', [27.2, 434.23, 64.33, 34.57]],
    [7, 3, 'SearchField', 'UISearchBarTextField', 'Search', [23.36, 482.24, 355.27, 40.33]],
    [8, 0, 'CollectionView', 'SwiftUI.CollectionView', undefined, [8, 482.24, 386, 331.91]],
    [9, 8, 'Cell', 'SwiftUI.ListCollectionViewCell', undefined, [23.36, 532.17, 355.27, 49.93]],
    [
      10,
      9,
      'Button',
      'SwiftUI.AccessibilityNode',
      'Primary action',
      [23.36, 532.17, 355.27, 49.93],
    ],
    [13, 8, 'Cell', 'SwiftUI.ListCollectionViewCell', undefined, [23.36, 632.03, 355.27, 49.93]],
    [14, 13, 'TextField', 'SwiftUI.UIKitTextField', 'Name', [38.73, 646.43, 324.55, 21.12]],
    [15, 8, 'Cell', 'SwiftUI.ListCollectionViewCell', undefined, [23.36, 681.96, 355.27, 132.19]],
    [16, 15, 'TextView', 'SwiftUI.TextEditorTextView', 'Notes', [38.73, 696.36, 324.55, 115.22]],
    [17, 0, 'Toolbar', '_UIFloatingBarContainerView', 'Toolbar', [8, 415.03, 386, 450.97]],
    [18, 17, 'Button', 'SwiftUI.AccessibilityNode', 'Bottom', [163.55, 798.79, 74.9, 34.57]],
  ]);

  assert.deepEqual(coveredLabels(nodes), []);
});

test('the captured iOS 27 sheet toolbar host with a hidden navigation bar stops condemning the list', () => {
  // The same host beside nothing but the list: with `.toolbar(.hidden, for: .navigationBar)` the
  // enclosed scroll region is the only sibling evidence the interactive projection keeps.
  const nodes = capturedTree([
    [0, undefined, 'Other', 'SwiftUIApplication', 'SheetRepro', [0, 0, 402, 874]],
    [1, 0, 'CollectionView', 'SwiftUI.CollectionView', undefined, [0, 100, 402, 712]],
    [2, 1, 'Cell', 'SwiftUI.ListCollectionViewCell', undefined, [16, 100, 370, 49]],
    [3, 2, 'Button', 'SwiftUI.AccessibilityNode', 'Barless primary', [16, 100, 370, 49]],
    [16, 1, 'Cell', 'SwiftUI.ListCollectionViewCell', 'Barless row 12', [16, 773, 370, 39]],
    [17, 0, 'Toolbar', '_UIFloatingBarContainerView', 'Toolbar', [0, 62, 402, 812]],
    [18, 17, 'Button', 'SwiftUI.AccessibilityNode', 'Barless bottom', [132.67, 804, 137, 36]],
  ]);

  assert.deepEqual(coveredLabels(nodes), []);
});

test('a navigation bar enclosing the navigation bar it was presented over still covers it', () => {
  // `snapshot -i` of a full-screen cover on an iOS 27 simulator: the cover's navigation bar encloses
  // the presenting screen's bar. A stacked bar is drawn over the one beneath, so only the toolbar
  // kind is read as a host.
  const nodes = capturedTree([
    [0, undefined, 'Other', 'SwiftUIApplication', 'SheetRepro', [0, 0, 402, 874]],
    [1, 0, 'NavigationBar', 'SwiftUI.UIKitNavigationBar', 'Home', [0, 62, 402, 106]],
    [2, 1, 'Button', 'SwiftUI.AccessibilityNode', 'Edit', [328.67, 66, 53.33, 36]],
    [19, 0, 'NavigationBar', 'SwiftUI.UIKitNavigationBar', 'Sheet cover', [0, 62, 402, 108]],
    [20, 19, 'Button', 'SwiftUI.AccessibilityNode', 'Close', [20, 66, 67, 36]],
  ]);

  assert.deepEqual(coveredLabels(nodes), ['Home', 'Edit']);
});

test('a toolbar host enclosing a plain content sibling still covers it, so the enclosed kind is gated', () => {
  // Non-vacuity for the host rule: the same host frame beside a plain `Other` branch instead of the
  // list keeps covering, as the containment case above requires.
  const nodes = capturedTree([
    [0, undefined, 'Other', 'SwiftUIApplication', 'SheetRepro', [0, 0, 402, 874]],
    [1, 0, 'Other', 'UIView', undefined, [0, 100, 402, 712]],
    [3, 1, 'Button', 'SwiftUI.AccessibilityNode', 'Barless primary', [16, 100, 370, 49]],
    [17, 0, 'Toolbar', '_UIFloatingBarContainerView', 'Toolbar', [0, 62, 402, 812]],
  ]);

  assert.deepEqual(coveredLabels(nodes), ['Other', 'Barless primary']);
});

// `snapshot -i` of a SwiftUI `fullScreenCover` presented from a `.large` sheet over the Home tab on an
// iOS 27 simulator, cells trimmed. All three presentations are listed as siblings of the root, each
// ending with its toolbar host. The sheet's host encloses Home's bar and list and the cover's.
const COVER_OVER_SHEET_ROWS: CapturedNode[] = [
  [0, undefined, 'Other', 'SwiftUIApplication', 'SheetRepro', [0, 0, 402, 874]],
  [1, 0, 'NavigationBar', 'SwiftUI.UIKitNavigationBar', undefined, [0, 62, 402, 106]],
  [2, 1, 'Button', 'SwiftUI.AccessibilityNode', 'Edit', [328.67, 66, 53.33, 36]],
  [4, 0, 'CollectionView', 'SwiftUI.UpdateCoalescingCollectionView', undefined, [0, 116, 402, 675]],
  [6, 4, 'Button', 'SwiftUI.AccessibilityNode', 'Open medium sheet', [16, 168, 370, 52]],
  [16, 0, 'Toolbar', '_UIFloatingBarContainerView', 'Toolbar', [0, 0, 402, 874]],
  [17, 0, 'TabBar', 'UITabBar', 'Tab Bar', [0, 791, 402, 83]],
  [18, 17, 'Button', '_UITabButton', 'Home', [68, 795, 94, 54]],
  [21, 0, 'NavigationBar', 'SwiftUI.UIKitNavigationBar', undefined, [0, 78, 402, 106]],
  [22, 21, 'Button', 'SwiftUI.AccessibilityNode', 'Close', [20, 82, 67, 36]],
  [
    26,
    0,
    'CollectionView',
    'SwiftUI.UpdateCoalescingCollectionView',
    undefined,
    [0, 132, 402, 680],
  ],
  [28, 26, 'Button', 'SwiftUI.AccessibilityNode', 'Primary action', [16, 184, 370, 52]],
  [43, 26, 'Button', 'SwiftUI.AccessibilityNode', 'Row 1', [16, 733, 370, 52]],
  [46, 0, 'Toolbar', '_UIFloatingBarContainerView', 'Toolbar', [0, 62, 402, 812]],
  [47, 46, 'Button', 'SwiftUI.AccessibilityNode', 'Bottom', [162, 804, 78, 36]],
  [48, 0, 'NavigationBar', 'SwiftUI.UIKitNavigationBar', undefined, [0, 62, 402, 54]],
  [49, 48, 'Button', 'SwiftUI.AccessibilityNode', 'Upper close', [20, 66, 116, 36]],
  [51, 48, 'Button', 'SwiftUI.AccessibilityNode', 'Upper save', [268, 66, 114, 36]],
  [
    52,
    0,
    'CollectionView',
    'SwiftUI.UpdateCoalescingCollectionView',
    undefined,
    [0, 116, 402, 696],
  ],
  [54, 52, 'Button', 'SwiftUI.AccessibilityNode', 'Upper primary', [16, 151, 370, 52]],
  [57, 52, 'Button', 'SwiftUI.AccessibilityNode', 'Upper row 0', [16, 255, 370, 52]],
  [68, 0, 'Toolbar', '_UIFloatingBarContainerView', 'Toolbar', [0, 0, 402, 874]],
  [69, 68, 'Button', 'SwiftUI.AccessibilityNode', 'Upper bottom', [136.67, 804, 128.67, 36]],
];

const HOME_ROW_INDEXES = new Set([1, 2, 4, 6, 16, 17, 18]);
const COVER_ROW_INDEXES = new Set([48, 49, 51, 52, 54, 57, 68, 69]);
const COVER_CONTROLS = [
  'Upper close',
  'Upper save',
  'Upper primary',
  'Upper row 0',
  'Upper bottom',
];

test('a full-screen cover over a sheet leaves the sheet beneath covered and the cover pressable', () => {
  const covered = coveredLabels(capturedTree(COVER_OVER_SHEET_ROWS));

  for (const label of ['Edit', 'Open medium sheet', 'Close', 'Primary action', 'Row 1']) {
    assert.ok(covered.includes(label), `${label} sits beneath the cover`);
  }
  for (const label of COVER_CONTROLS) {
    assert.ok(!covered.includes(label), `${label} is on the cover`);
  }
});

test('a toolbar host enclosing the bars of a presentation stacked over it keeps covering', () => {
  // The capture without Home: only the cover's bar and list, listed after the sheet's host, tell it
  // apart from a lone sheet.
  const rows = COVER_OVER_SHEET_ROWS.filter(([index]) => !HOME_ROW_INDEXES.has(index));
  const covered = coveredLabels(capturedTree(rows));

  assert.ok(covered.includes('Primary action'));
  assert.ok(covered.includes('Row 1'));
  for (const label of COVER_CONTROLS) assert.ok(!covered.includes(label));
});

test('a toolbar host enclosing the bars of a presentation beneath it keeps covering', () => {
  // The capture without the cover: a sheet host enclosing Home's bar and list, which sit before Home's
  // own host, covers Home. It covers the sheet too, failing closed; iOS publishes no presentation
  // beneath a sheet, so this shape is not captured live.
  const rows = COVER_OVER_SHEET_ROWS.filter(([index]) => !COVER_ROW_INDEXES.has(index));
  const covered = coveredLabels(capturedTree(rows));

  assert.ok(covered.includes('Edit'));
  assert.ok(covered.includes('Open medium sheet'));
});

test.for([
  {
    name: 'a sheet over a sheet',
    rows: [
      [0, undefined, 'Other', 'SwiftUIApplication', 'SheetRepro', [0, 0, 402, 874]],
      [1, 0, 'NavigationBar', 'SwiftUI.UIKitNavigationBar', undefined, [0, 88, 402, 54]],
      [2, 1, 'Button', 'SwiftUI.AccessibilityNode', 'Upper close', [20, 92, 116, 36]],
      [4, 1, 'Button', 'SwiftUI.AccessibilityNode', 'Upper save', [268, 92, 114, 36]],
      [
        5,
        0,
        'CollectionView',
        'SwiftUI.UpdateCoalescingCollectionView',
        undefined,
        [0, 142, 402, 670],
      ],
      [7, 5, 'Button', 'SwiftUI.AccessibilityNode', 'Upper primary', [16, 177, 370, 52]],
      [20, 5, 'Button', 'SwiftUI.AccessibilityNode', 'Upper row 5', [16, 541, 370, 52]],
      [21, 0, 'Toolbar', '_UIFloatingBarContainerView', 'Toolbar', [0, 72, 402, 802]],
      [22, 21, 'Button', 'SwiftUI.AccessibilityNode', 'Upper bottom', [136.67, 804, 128.67, 36]],
    ],
  },
  {
    name: 'a sheet over a plain screen',
    rows: [
      [0, undefined, 'Other', 'SwiftUIApplication', 'SheetRepro', [0, 0, 402, 874]],
      [1, 0, 'NavigationBar', 'SwiftUI.UIKitNavigationBar', undefined, [0, 78, 402, 54]],
      [2, 1, 'Button', 'SwiftUI.AccessibilityNode', 'Upper close', [20, 82, 116, 36]],
      [4, 1, 'Button', 'SwiftUI.AccessibilityNode', 'Upper save', [268, 82, 114, 36]],
      [
        5,
        0,
        'CollectionView',
        'SwiftUI.UpdateCoalescingCollectionView',
        undefined,
        [0, 132, 402, 680],
      ],
      [7, 5, 'Button', 'SwiftUI.AccessibilityNode', 'Upper primary', [16, 167, 370, 52]],
      [20, 5, 'Button', 'SwiftUI.AccessibilityNode', 'Upper row 5', [16, 531, 370, 52]],
      [21, 0, 'Toolbar', '_UIFloatingBarContainerView', 'Toolbar', [0, 62, 402, 812]],
      [22, 21, 'Button', 'SwiftUI.AccessibilityNode', 'Upper bottom', [136.67, 804, 128.67, 36]],
    ],
  },
] satisfies { name: string; rows: CapturedNode[] }[])(
  'the captured iOS 27 $name publishes only the top sheet, and none of it is covered',
  ({ rows }) => {
    // iOS drops the presentation beneath a sheet from the capture, so no lower control gets a ref.
    assert.deepEqual(coveredLabels(capturedTree(rows)), []);
  },
);

test('a toolbar host enclosing only a scroll indicator still covers, so the scroll evidence is a container', () => {
  const nodes = capturedTree([
    [0, undefined, 'Other', 'SwiftUIApplication', 'SheetRepro', [0, 0, 402, 874]],
    [1, 0, 'Other', 'UIView', undefined, [0, 100, 402, 712]],
    [3, 1, 'Button', 'SwiftUI.AccessibilityNode', 'Barless primary', [16, 100, 370, 49]],
    [4, 0, 'ScrollBar', '_UIScrollViewScrollIndicator', undefined, [396, 100, 3, 712]],
    [17, 0, 'Toolbar', '_UIFloatingBarContainerView', 'Toolbar', [0, 62, 402, 812]],
  ]);

  assert.ok(coveredLabels(nodes).includes('Barless primary'));
});

test.for([
  {
    name: 'an Android RecyclerView type',
    type: 'androidx.recyclerview.widget.RecyclerView',
    role: '',
  },
  { name: 'a scroll kind published only in role', type: 'Other', role: 'UIScrollView' },
])('a toolbar host enclosing $name reads it as a scroll container', ({ type, role }) => {
  const nodes = capturedTree([
    [0, undefined, 'Other', 'SwiftUIApplication', 'SheetRepro', [0, 0, 402, 874]],
    [1, 0, type, role, undefined, [0, 100, 402, 712]],
    [3, 1, 'Button', 'SwiftUI.AccessibilityNode', 'Barless primary', [16, 100, 370, 49]],
    [17, 0, 'Toolbar', '_UIFloatingBarContainerView', 'Toolbar', [0, 62, 402, 812]],
  ]);

  assert.deepEqual(coveredLabels(nodes), []);
});

test('a control the exempt toolbar host really hosts still covers the row it overlaps', () => {
  // The host is exempt for the list it encloses, but a bar-kind strip it hosts is judged by its own
  // rect: it covers the row beneath it and leaves the row above it alone.
  const nodes = capturedTree([
    [0, undefined, 'Other', 'SwiftUIApplication', 'SheetRepro', [0, 0, 402, 874]],
    [1, 0, 'CollectionView', 'SwiftUI.CollectionView', undefined, [0, 100, 402, 712]],
    [3, 1, 'Button', 'SwiftUI.AccessibilityNode', 'Barless primary', [16, 100, 370, 49]],
    [16, 1, 'Button', 'SwiftUI.AccessibilityNode', 'Barless row 12', [16, 773, 370, 39]],
    [17, 0, 'Toolbar', '_UIFloatingBarContainerView', 'Toolbar', [0, 62, 402, 812]],
    [18, 17, 'Toolbar', '_UIBarPlatterView', 'Bottom bar', [16, 760, 370, 60]],
  ]);

  assert.deepEqual(coveredLabels(nodes), ['Barless row 12']);
});
