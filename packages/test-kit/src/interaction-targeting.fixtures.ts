import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

export const EQUIVALENT_WRAPPER_CHAIN_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 1,
    parentIndex: 3,
    type: 'XCUIElementTypeCell',
    label: 'Chat',
    rect: { x: 10, y: 20, width: 300, height: 60 },
    hittable: false,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Chat',
    rect: { x: 10, y: 20, width: 300, height: 60 },
    hittable: true,
  },
  {
    index: 2,
    depth: 2,
    parentIndex: 1,
    type: 'XCUIElementTypeStaticText',
    label: 'Chat',
    rect: { x: 24, y: 32, width: 80, height: 20 },
    hittable: false,
  },
  {
    index: 3,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: true,
  },
];

export const ELEMENT14_DISTINCT_SUBTREE_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: true,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeStaticText',
    label: 'Team Standup',
    rect: { x: 20, y: 80, width: 200, height: 30 },
    hittable: false,
  },
  {
    index: 2,
    depth: 2,
    parentIndex: 0,
    type: 'XCUIElementTypeTextField',
    label: 'Team Standup',
    rect: { x: 20, y: 130, width: 350, height: 44 },
    hittable: false,
  },
  {
    index: 3,
    depth: 3,
    parentIndex: 0,
    type: 'XCUIElementTypeCell',
    label: 'Team Standup',
    rect: { x: 10, y: 180, width: 370, height: 80 },
    hittable: true,
  },
  {
    index: 4,
    depth: 8,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Team Standup',
    rect: { x: 151, y: 194, width: 100, height: 40 },
    hittable: true,
  },
];

/**
 * One node per decision `resolveActionableTouchResolution` can reach, so an
 * indexed pass and an unindexed one can be compared across the whole policy
 * rather than on the branch a single example happens to hit: a same-rect
 * actionable descendant (1 -> 2), semantic targets (3, 4), a nonhittable leaf
 * under a hittable ancestor (5), both overly-broad shapes — a scrolling
 * container (7) and the viewport-sized root (10) — a covered node (8), and a
 * parentless, rectless node with no usable target at all (9).
 */
export const INDEXED_PARITY_POLICY_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: true,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeOther',
    label: 'Save wrapper',
    rect: { x: 20, y: 100, width: 120, height: 44 },
    hittable: false,
  },
  {
    index: 2,
    depth: 2,
    parentIndex: 1,
    type: 'XCUIElementTypeImage',
    identifier: 'save-hit-area',
    rect: { x: 20, y: 100, width: 120, height: 44 },
    hittable: true,
  },
  {
    index: 3,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Save',
    rect: { x: 20, y: 200, width: 100, height: 40 },
    hittable: false,
  },
  {
    index: 4,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeCell',
    label: 'Account row',
    rect: { x: 10, y: 260, width: 370, height: 60 },
    hittable: true,
  },
  {
    index: 5,
    depth: 2,
    parentIndex: 4,
    type: 'XCUIElementTypeStaticText',
    label: 'Account',
    rect: { x: 24, y: 272, width: 80, height: 20 },
    hittable: false,
  },
  {
    index: 6,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeScrollView',
    rect: { x: 0, y: 340, width: 390, height: 300 },
    hittable: true,
  },
  {
    index: 7,
    depth: 2,
    parentIndex: 6,
    type: 'XCUIElementTypeOther',
    label: 'Feed item',
    rect: { x: 20, y: 360, width: 200, height: 40 },
    hittable: false,
  },
  {
    index: 8,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeStaticText',
    label: 'Under overlay',
    rect: { x: 20, y: 700, width: 100, height: 20 },
    hittable: false,
    interactionBlocked: 'covered',
  },
  {
    index: 9,
    depth: 0,
    type: 'XCUIElementTypeOther',
    label: 'Virtual item',
    hittable: false,
  },
  {
    index: 10,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeStaticText',
    label: 'Status',
    rect: { x: 20, y: 760, width: 60, height: 20 },
    hittable: false,
  },
];

/**
 * A cell and the button inside it, both reporting one identifier with no
 * hittability evidence and rects within wrapper slack. Both are actionable
 * targets, so this is two controls rather than one control and its wrapper: the
 * collapse has to refuse it.
 */
export const TWO_ACTIONABLE_WRAPPER_CHAIN_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 1,
    parentIndex: 2,
    type: 'XCUIElementTypeCell',
    identifier: 'profile',
    rect: { x: 20, y: 63, width: 36, height: 36 },
  },
  {
    index: 1,
    depth: 2,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    identifier: 'profile',
    rect: { x: 20.666666666666668, y: 63, width: 35, height: 36 },
  },
  {
    index: 2,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 393, height: 852 },
  },
];

/**
 * The SwiftUI toolbar shape on a regular iOS snapshot: a wrapper and its
 * control share one identifier, the platform reports NO hittability evidence
 * (so neither node is `hittable: true`), and the wrapper's rect carries the
 * union of the control's sub-pixel layout. Captured from a live simulator with
 * resolved sub-pixel values.
 */
export const UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 2,
    parentIndex: 2,
    type: 'XCUIElementTypeOther',
    identifier: 'scoring_home_button',
    label: 'Home',
    rect: { x: 20, y: 63, width: 36, height: 36 },
  },
  {
    index: 1,
    depth: 3,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    identifier: 'scoring_home_button',
    label: 'Home',
    rect: { x: 20.666666666666668, y: 63, width: 35, height: 36 },
  },
  {
    index: 2,
    depth: 1,
    type: 'XCUIElementTypeNavigationBar',
    rect: { x: 0, y: 59, width: 393, height: 54 },
  },
  {
    index: 3,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    label: 'PipCount',
    rect: { x: 0, y: 0, width: 393, height: 852 },
  },
];

/**
 * React Native text as an iOS regular snapshot reports it (#2870), captured live
 * from the fixture app's Catalog screen: the paragraph view carries the label and
 * the app's own `testID`, and its `RCTAccessibilityElement` child mirrors the
 * identical label at the identical rect. Both nodes carry a `hittable` fact, which
 * is why the hittability-door wrapper rule above declines this pair and the
 * text-echo rule exists. The pair denotes one authored `<Text>`, and the reporter
 * is the outer node — the one whose `identifier` an `id=` selector targets.
 */
export const RN_TEXT_ECHO_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 2,
    parentIndex: 2,
    type: 'XCUIElementTypeStaticText',
    role: 'RCTParagraphComponentView',
    subrole: 'UIView',
    identifier: 'catalog-scroll-state',
    label: 'Catalog scroll: top',
    rect: { x: 18, y: 168, width: 350, height: 17 },
    enabled: true,
    hittable: true,
  },
  {
    index: 1,
    depth: 3,
    parentIndex: 0,
    type: 'XCUIElementTypeStaticText',
    role: 'RCTAccessibilityElement',
    subrole: 'UIAccessibilityElement',
    label: 'Catalog scroll: top',
    rect: { x: 18, y: 168, width: 350, height: 17 },
    enabled: true,
    hittable: true,
  },
  {
    index: 2,
    depth: 1,
    parentIndex: 3,
    type: 'XCUIElementTypeOther',
    rect: { x: 0, y: 0, width: 386, height: 678 },
    enabled: true,
    hittable: true,
  },
  {
    index: 3,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    label: 'Agent Device Tester',
    rect: { x: 0, y: 0, width: 386, height: 678 },
    enabled: true,
    hittable: false,
  },
];

/**
 * The closest negative to the text echo: two nodes carrying the same label at the
 * same rect in DIFFERENT subtrees. Identical label, rect, and role vocabulary —
 * only the ancestry separates them from the pair above, so this is what proves the
 * collapse reads structure rather than the description a match shares.
 */
export const RN_TEXT_ECHO_DISTINCT_SUBTREE_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 1,
    parentIndex: 2,
    type: 'XCUIElementTypeStaticText',
    label: 'Catalog scroll: top',
    rect: { x: 18, y: 168, width: 350, height: 17 },
    enabled: true,
    hittable: true,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 3,
    type: 'XCUIElementTypeStaticText',
    label: 'Catalog scroll: top',
    rect: { x: 18, y: 168, width: 350, height: 17 },
    enabled: true,
    hittable: true,
  },
  {
    index: 2,
    depth: 0,
    type: 'XCUIElementTypeOther',
    rect: { x: 0, y: 0, width: 193, height: 678 },
    enabled: true,
    hittable: true,
  },
  {
    index: 3,
    depth: 0,
    type: 'XCUIElementTypeOther',
    rect: { x: 193, y: 0, width: 193, height: 678 },
    enabled: true,
    hittable: true,
  },
];

/**
 * The other closest negative: one ancestry chain whose descendant repeats the
 * ancestor's label at a DIFFERENT rect — two runs of the same words, which is two
 * elements the caller still has to choose between. Roles mirror the live RN pair
 * so the rect is the ONLY fact that differs from the collapsing positive.
 */
export const RN_TEXT_ECHO_OFFSET_RECT_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 1,
    parentIndex: 2,
    type: 'XCUIElementTypeStaticText',
    role: 'RCTParagraphComponentView',
    subrole: 'UIView',
    label: 'Catalog scroll: top',
    rect: { x: 18, y: 168, width: 350, height: 17 },
    enabled: true,
    hittable: true,
  },
  {
    index: 1,
    depth: 2,
    parentIndex: 0,
    type: 'XCUIElementTypeStaticText',
    role: 'RCTAccessibilityElement',
    subrole: 'UIAccessibilityElement',
    label: 'Catalog scroll: top',
    rect: { x: 18, y: 420, width: 350, height: 17 },
    enabled: true,
    hittable: true,
  },
  {
    index: 2,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 386, height: 678 },
    enabled: true,
    hittable: true,
  },
];

/**
 * The reportage negative: one ancestry chain with the identical label at the
 * identical rect — the shape geometry cannot distinguish — where the descendant
 * is an AUTHORED element (a nested `<Text>` or a `<View>` carrying the same
 * accessibilityLabel, view-backed role/subrole), not the accessibility element
 * the platform reports for the reporter. Same frame, same label, two authored
 * elements: the collapse rule's `isReportedAccessibilityElement` clause keeps
 * this ambiguous.
 */
export const RN_TEXT_ECHO_AUTHORED_CHILD_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 1,
    parentIndex: 2,
    type: 'XCUIElementTypeStaticText',
    role: 'RCTParagraphComponentView',
    subrole: 'UIView',
    label: 'Catalog scroll: top',
    rect: { x: 18, y: 168, width: 350, height: 17 },
    enabled: true,
    hittable: true,
  },
  {
    index: 1,
    depth: 2,
    parentIndex: 0,
    type: 'RCTParagraphComponentView',
    role: 'RCTParagraphComponentView',
    subrole: 'UIView',
    label: 'Catalog scroll: top',
    rect: { x: 18, y: 168, width: 350, height: 17 },
    enabled: true,
    hittable: true,
  },
  {
    index: 2,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 386, height: 678 },
    enabled: true,
    hittable: true,
  },
];
