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
