import type { IosCollapsedTabBarProbeFailure } from '@agent-device/contracts/ios-snapshot';
import type { Rect } from '@agent-device/kernel/snapshot';
import {
  readIosNodeChildren,
  readIosNodeRect,
  type IosTreeNode,
} from '@agent-device/capture-kit/ios-ax-tree';

type Point = { x: number; y: number };

/** One Limrun hit-test: the element tree at `point`, as `client.elementTree(point)` returns it. */
type LimrunIosHitTest = (point: Point) => Promise<IosTreeNode | IosTreeNode[]>;

/** Preferred spacing of the hit-tests across a bar. */
const TAB_PROBE_SPACING = 32;
/** Widest spacing that still hits every tab: the 44 pt minimum tap target. */
const MAX_TAB_PROBE_SPACING = 44;
/** The most hit-tests one snapshot sends, shared out over every candidate bar. */
const MAX_TAB_PROBES = 24;
/** Heights a docked iOS tab bar takes, with or without the home indicator inset below it. */
const TAB_BAR_HEIGHT = { min: 44, max: 100 };
/**
 * How long a candidate's parallel hit-tests may take. A live probe answers in about 150 ms; the
 * SDK's own request timeout is 30 s, which would stall the snapshot.
 */
const TAB_PROBE_TIMEOUT_MS = 1_500;

/**
 * The tree with a collapsed tab bar's tabs published as its children. A live Limrun iPhone
 * reports the iOS tab bar as one childless `Group` along the viewport's bottom edge, with no tab
 * trait, while hit-tests inside its frame return the tab buttons. This applies the Apple runner's
 * collapsed tab container rule (`isCollapsedTabContainer`, `collapsedTabFallbackNodes`) to those
 * hit-tests; Limrun marks a tab with the `TabButton` trait, which stands in for the runner's
 * candidate types. `contracts/fixtures/ios-collapsed-tab-geometry.json` holds the shared geometry.
 *
 * Candidates are probed most tab-bar-like first (a tab bar's height, then the lowest top edge)
 * until one yields tabs, each with an even share of what is left of the budget but never fewer
 * probes than reach every tab. Expansion is all or nothing. The tree keeps its reported shape, and
 * `probeFailure` says why, when a candidate's hit-test fails (`rejected`), when it does not answer
 * within the timeout (`timed-out`), or when the budget runs out before a candidate with a tab
 * bar's height is checked (`budget-exhausted`). A partial tab set would look complete.
 */
export async function expandLimrunCollapsedTabBar(
  tree: IosTreeNode | IosTreeNode[],
  viewport: Rect | null,
  hitTest: LimrunIosHitTest,
): Promise<{ tree: IosTreeNode[]; probeFailure?: IosCollapsedTabBarProbeFailure }> {
  const roots = Array.isArray(tree) ? tree : [tree];
  if (!viewport) return { tree: roots };
  const bars = collapsedTabBars(roots, viewport).sort(byTabBarLikeness);
  let remaining = MAX_TAB_PROBES;
  for (const [index, bar] of bars.entries()) {
    const points = tabProbePoints(bar.frame, remaining, bars.length - index);
    if (!points) {
      const missed = bars.slice(index).some(({ frame }) => hasTabBarHeight(frame));
      return missed ? { tree: roots, probeFailure: 'budget-exhausted' } : { tree: roots };
    }
    remaining -= points.length;
    const outcome = await probe(points, hitTest);
    if ('failure' in outcome) return { tree: roots, probeFailure: outcome.failure };
    const tabs = collapsedTabBarTabs(bar.frame, outcome.hits);
    if (tabs.length > 0) {
      return { tree: roots.map((root) => withTabs(root, bar.node, tabs)) };
    }
  }
  return { tree: roots };
}

function withTabs(node: IosTreeNode, bar: IosTreeNode, tabs: IosTreeNode[]): IosTreeNode {
  if (node === bar) return { ...node, children: tabs };
  const children = readIosNodeChildren(node);
  return children.length === 0
    ? node
    : { ...node, children: children.map((child) => withTabs(child, bar, tabs)) };
}

function collapsedTabBars(roots: IosTreeNode[], viewport: Rect) {
  const bars: { node: IosTreeNode; frame: Rect }[] = [];
  const visit = (node: IosTreeNode) => {
    const children = readIosNodeChildren(node);
    const frame = readIosNodeRect(node);
    if (children.length === 0 && frame && isCollapsedTabBar(node, frame, viewport)) {
      bars.push({ node, frame });
    }
    children.forEach(visit);
  };
  roots.forEach(visit);
  return bars;
}

function hasTabBarHeight(frame: Rect): boolean {
  return frame.height >= TAB_BAR_HEIGHT.min && frame.height <= TAB_BAR_HEIGHT.max;
}

function byTabBarLikeness(left: { frame: Rect }, right: { frame: Rect }): number {
  const rank = (frame: Rect) => (hasTabBarHeight(frame) ? 0 : 1);
  return rank(left.frame) - rank(right.frame) || right.frame.y - left.frame.y;
}

/** The runner's wide childless container, in the shape Limrun reports an iPhone tab bar. */
function isCollapsedTabBar(node: IosTreeNode, frame: Rect, viewport: Rect): boolean {
  if ((node.elementType ?? node.type) !== 'Group') return false;
  if (frame.width <= 0 || frame.height <= 0) return false;
  if (frame.width < Math.max(160, frame.height * 1.75)) return false;
  return (
    Math.abs(frame.x - viewport.x) <= 1 &&
    Math.abs(frame.x + frame.width - (viewport.x + viewport.width)) <= 1 &&
    Math.abs(frame.y + frame.height - (viewport.y + viewport.height)) <= 1
  );
}

/**
 * Points across the bar's middle: this candidate's even share of the probes left, raised to the
 * count that reaches every tab, or undefined when the probes left cannot.
 */
function tabProbePoints(
  frame: Rect,
  remaining: number,
  candidatesLeft: number,
): Point[] | undefined {
  const needed = Math.ceil(frame.width / MAX_TAB_PROBE_SPACING);
  if (remaining < needed) return undefined;
  const share = Math.floor(remaining / candidatesLeft);
  const preferred = Math.ceil(frame.width / TAB_PROBE_SPACING);
  const count = Math.min(remaining, Math.max(needed, Math.min(preferred, share)));
  const y = frame.y + frame.height / 2;
  return Array.from({ length: count }, (_, index) => ({
    x: frame.x + (frame.width * (index + 0.5)) / count,
    y,
  }));
}

async function probe(
  points: Point[],
  hitTest: LimrunIosHitTest,
): Promise<{ hits: IosTreeNode[] } | { failure: IosCollapsedTabBarProbeFailure }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ failure: IosCollapsedTabBarProbeFailure }>((resolve) => {
    timer = setTimeout(() => resolve({ failure: 'timed-out' }), TAB_PROBE_TIMEOUT_MS);
  });
  const answered = Promise.all(points.map(hitTest)).then(
    (hits) => ({ hits: hits.flatMap(flattenHit) }),
    () => ({ failure: 'rejected' as const }),
  );
  try {
    return await Promise.race([answered, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function flattenHit(hit: IosTreeNode | IosTreeNode[]): IosTreeNode[] {
  const nodes: IosTreeNode[] = [];
  const visit = (node: IosTreeNode) => {
    nodes.push(node);
    readIosNodeChildren(node).forEach(visit);
  };
  (Array.isArray(hit) ? hit : [hit]).forEach(visit);
  return nodes;
}

/** `collapsedTabFallbackNodes`: at least two distinct tabs inside the bar, in one row. */
function collapsedTabBarTabs(barFrame: Rect, hits: IosTreeNode[]): IosTreeNode[] {
  const seen = new Set<string>();
  const tabs: { node: IosTreeNode; frame: Rect }[] = [];
  for (const node of hits) {
    const frame = readIosNodeRect(node);
    if (!frame || !isTabButton(node) || !isTabInside(frame, barFrame)) continue;
    const key = JSON.stringify([
      node.elementType ?? node.type,
      node.label ?? node.AXLabel,
      node.identifier ?? node.AXUniqueId,
      node.value ?? node.AXValue,
      frame,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push({ node: { ...node, children: [] }, frame });
  }
  if (tabs.length < 2) return [];
  const midpoints = tabs.map(({ frame }) => frame.y + frame.height / 2);
  const rowSpread = Math.max(...midpoints) - Math.min(...midpoints);
  if (rowSpread > Math.max(24, barFrame.height * 0.6)) return [];
  return tabs
    .sort((left, right) => left.frame.x - right.frame.x || left.frame.y - right.frame.y)
    .map(({ node }) => node);
}

function isTabButton(node: IosTreeNode): boolean {
  if (node.traits?.includes('TabButton') !== true) return false;
  return [
    node.label,
    node.AXLabel,
    node.identifier,
    node.AXUniqueId,
    node.value,
    node.AXValue,
  ].some((text) => text !== undefined && text !== null && String(text).trim() !== '');
}

/** `isCollapsedTabCandidate`: smaller than the bar and centered inside it. */
function isTabInside(frame: Rect, barFrame: Rect): boolean {
  if (frame.width <= 0 || frame.height <= 0) return false;
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  return (
    frame.width * frame.height < barFrame.width * barFrame.height * 0.9 &&
    centerX >= barFrame.x &&
    centerX <= barFrame.x + barFrame.width &&
    centerY >= barFrame.y &&
    centerY <= barFrame.y + barFrame.height
  );
}
