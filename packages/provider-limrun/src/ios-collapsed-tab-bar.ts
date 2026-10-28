import type { Rect } from '@agent-device/kernel/snapshot';
import { readIosNodeChildren, readIosNodeRect, type IosTreeNode } from './snapshot.ts';

type Point = { x: number; y: number };

/** One Limrun hit-test: the element tree at `point`, as `client.elementTree(point)` returns it. */
type LimrunIosHitTest = (point: Point) => Promise<IosTreeNode | IosTreeNode[]>;

/** Horizontal spacing of the hit-tests across a collapsed tab bar; below the 44 pt minimum tab width. */
const TAB_PROBE_SPACING = 32;
/** The most hit-tests one snapshot sends. They run in parallel, so the added latency is about one round trip. */
const MAX_TAB_PROBES = 24;

/**
 * The tree with a collapsed tab bar's tabs published as its children. A live Limrun iPhone
 * reports the iOS tab bar as one childless `Group` along the viewport's bottom edge, with no tab
 * trait, while hit-tests inside its frame return the tab buttons. This applies the Apple runner's
 * collapsed tab container rule (`isCollapsedTabContainer`, `collapsedTabFallbackNodes`) to those
 * hit-tests; Limrun marks a tab with the `TabButton` trait, which stands in for the runner's
 * candidate types.
 */
export async function expandLimrunCollapsedTabBar(
  tree: IosTreeNode | IosTreeNode[],
  viewport: Rect | null,
  hitTest: LimrunIosHitTest,
): Promise<IosTreeNode[]> {
  const roots = Array.isArray(tree) ? tree : [tree];
  const bar = viewport ? findCollapsedTabBar(roots, viewport) : undefined;
  if (!bar) return roots;
  const hits = await Promise.all(tabProbePoints(bar.frame).map(hitTest));
  const tabs = collapsedTabBarTabs(bar.frame, hits.flatMap(flattenHit));
  if (tabs.length === 0) return roots;
  const rebuild = (node: IosTreeNode): IosTreeNode => {
    if (node === bar.node) return { ...node, children: tabs };
    const children = readIosNodeChildren(node);
    return children.length === 0 ? node : { ...node, children: children.map(rebuild) };
  };
  return roots.map(rebuild);
}

function findCollapsedTabBar(
  nodes: IosTreeNode[],
  viewport: Rect,
): { node: IosTreeNode; frame: Rect } | undefined {
  for (const node of nodes) {
    const children = readIosNodeChildren(node);
    const frame = readIosNodeRect(node);
    if (children.length === 0 && frame && isCollapsedTabBar(node, frame, viewport)) {
      return { node, frame };
    }
    const bar = findCollapsedTabBar(children, viewport);
    if (bar) return bar;
  }
  return undefined;
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

function tabProbePoints(frame: Rect): Point[] {
  const count = Math.min(MAX_TAB_PROBES, Math.ceil(frame.width / TAB_PROBE_SPACING));
  const y = frame.y + frame.height / 2;
  return Array.from({ length: count }, (_, index) => ({
    x: frame.x + (frame.width * (index + 0.5)) / count,
    y,
  }));
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
