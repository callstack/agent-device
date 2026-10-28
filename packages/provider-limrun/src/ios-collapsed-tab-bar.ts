import type { IosAcquisitionResidue } from '@agent-device/contracts/ios-snapshot';
import type { Rect } from '@agent-device/kernel/snapshot';
import { readIosNodeChildren, readIosNodeRect, type IosTreeNode } from './snapshot.ts';

type Point = { x: number; y: number };

/** One Limrun hit-test: the element tree at `point`, as `client.elementTree(point)` returns it. */
type LimrunIosHitTest = (point: Point) => Promise<IosTreeNode | IosTreeNode[]>;

type ProbeFailure = Extract<IosAcquisitionResidue, { kind: 'collapsed-tab-bar-probe-failed' }>;

/** Preferred spacing of the hit-tests across a bar. */
const TAB_PROBE_SPACING = 32;
/** Widest spacing that still hits every tab: the 44 pt minimum tap target. */
const MAX_TAB_PROBE_SPACING = 44;
/** The most hit-tests one snapshot sends, over every candidate bar. */
const MAX_TAB_PROBES = 24;
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
 * Candidates are probed in tree order until one yields tabs. Expansion is all or nothing: when a
 * candidate's hit-test fails, that bar keeps its reported shape, the residue says why, and no
 * further candidate is probed. A partial tab set would look complete.
 */
export async function expandLimrunCollapsedTabBar(
  tree: IosTreeNode | IosTreeNode[],
  viewport: Rect | null,
  hitTest: LimrunIosHitTest,
): Promise<{ tree: IosTreeNode[]; residue: ProbeFailure[] }> {
  const roots = Array.isArray(tree) ? tree : [tree];
  if (!viewport) return { tree: roots, residue: [] };
  let remaining = MAX_TAB_PROBES;
  for (const bar of collapsedTabBars(roots, viewport)) {
    const points = tabProbePoints(bar.frame, remaining);
    if (!points) break;
    remaining -= points.length;
    const outcome = await probe(points, hitTest);
    if ('reason' in outcome) return { tree: roots, residue: [outcome] };
    const tabs = collapsedTabBarTabs(bar.frame, outcome.hits);
    if (tabs.length > 0) {
      return { tree: roots.map((root) => withTabs(root, bar.node, tabs)), residue: [] };
    }
  }
  return { tree: roots, residue: [] };
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

/** Points across the bar's middle, or undefined when the budget left cannot reach every tab. */
function tabProbePoints(frame: Rect, budget: number): Point[] | undefined {
  const needed = Math.ceil(frame.width / MAX_TAB_PROBE_SPACING);
  if (budget < needed) return undefined;
  const count = Math.min(budget, Math.max(needed, Math.ceil(frame.width / TAB_PROBE_SPACING)));
  const y = frame.y + frame.height / 2;
  return Array.from({ length: count }, (_, index) => ({
    x: frame.x + (frame.width * (index + 0.5)) / count,
    y,
  }));
}

async function probe(
  points: Point[],
  hitTest: LimrunIosHitTest,
): Promise<{ hits: IosTreeNode[] } | ProbeFailure> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ProbeFailure>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: 'collapsed-tab-bar-probe-failed', reason: 'timed-out' }),
      TAB_PROBE_TIMEOUT_MS,
    );
  });
  const answered = Promise.all(points.map(hitTest)).then(
    (hits) => ({ hits: hits.flatMap(flattenHit) }),
    (): ProbeFailure => ({ kind: 'collapsed-tab-bar-probe-failed', reason: 'rejected' }),
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
