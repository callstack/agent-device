import type { HiddenContentHint, RawSnapshotNode, Rect } from '../../utils/snapshot.ts';
import { isScrollableType } from '../../utils/scrollable.ts';

type ViewNode = {
  className: string;
  rect: Rect;
  children: ViewNode[];
};

type FlowBlock = {
  start: number;
  size: number;
  crossSize: number;
};

export function deriveAndroidScrollableContentHints(
  nodes: RawSnapshotNode[],
  activityTopDump: string,
): Map<number, HiddenContentHint> {
  const viewTree = parseActivityTopViewTree(activityTopDump);
  if (!viewTree) {
    return new Map();
  }

  const nativeScrollViews = collectNativeScrollViews(viewTree);
  if (nativeScrollViews.length === 0) {
    return new Map();
  }

  const hintsByIndex = new Map<number, HiddenContentHint>();
  for (const node of nodes) {
    if (!node.rect || !isScrollableType(node.type)) {
      continue;
    }
    const nativeScrollView = matchNativeScrollView(node.rect, nativeScrollViews);
    if (!nativeScrollView) {
      continue;
    }
    const visibleBlocks = collectVisibleFlowBlocks(nodes, node);
    const hiddenContent = inferHiddenScrollableContent({
      viewportRect: node.rect,
      visibleBlocks,
      nativeScrollView,
    });
    if (!hiddenContent) {
      continue;
    }
    const hint: HiddenContentHint = {};
    if (hiddenContent.above) {
      hint.hiddenContentAbove = true;
    }
    if (hiddenContent.below) {
      hint.hiddenContentBelow = true;
    }
    if (hint.hiddenContentAbove || hint.hiddenContentBelow) {
      hintsByIndex.set(node.index, hint);
    }
  }
  return hintsByIndex;
}

type NativeScrollView = {
  rect: Rect;
  contentExtent: number;
  contentBlocks: FlowBlock[];
};

// fallow-ignore-next-line complexity
function inferHiddenScrollableContent(params: {
  viewportRect: Rect;
  visibleBlocks: FlowBlock[];
  nativeScrollView: NativeScrollView;
}): { above?: boolean; below?: boolean } | null {
  const { viewportRect, visibleBlocks, nativeScrollView } = params;
  if (visibleBlocks.length === 0 || nativeScrollView.contentBlocks.length === 0) {
    return null;
  }
  // Virtualized Android lists often mount only the currently visible rows, so coverage gaps
  // in the native content tree are the strongest signal. Offset matching remains useful for
  // shallow scroll positions where content is still fully mounted and the first block is only
  // slightly displaced, which coverage thresholds intentionally treat as inconclusive.
  const mountedCoverageHiddenContent = inferMountedCoverageHiddenContent(nativeScrollView);
  const offset =
    estimateScrollOffset(nativeScrollView.contentBlocks, visibleBlocks) ??
    estimateEdgeAlignedScrollOffset({
      nativeBlocks: nativeScrollView.contentBlocks,
      visibleBlocks,
      viewportExtent: viewportRect.height,
      contentExtent: nativeScrollView.contentExtent,
    });
  if (offset === null) {
    return mountedCoverageHiddenContent;
  }

  const viewportExtent = viewportRect.height;
  const hiddenBefore = (mountedCoverageHiddenContent?.above ?? false) || offset > 16;
  const hiddenAfter =
    (mountedCoverageHiddenContent?.below ?? false) ||
    offset + viewportExtent < nativeScrollView.contentExtent - 16;

  return { above: hiddenBefore, below: hiddenAfter };
}

function inferMountedCoverageHiddenContent(
  nativeScrollView: NativeScrollView,
): { above?: boolean; below?: boolean } | null {
  if (nativeScrollView.contentBlocks.length === 0) {
    return null;
  }
  const firstBlock = nativeScrollView.contentBlocks[0];
  const lastBlock = nativeScrollView.contentBlocks[nativeScrollView.contentBlocks.length - 1];
  if (!firstBlock || !lastBlock) {
    return null;
  }

  const medianBlockSize =
    median(nativeScrollView.contentBlocks.map((block) => block.size)) ??
    nativeScrollView.rect.height;
  const hiddenAboveThreshold = Math.max(48, Math.round(medianBlockSize * 0.5));
  const hiddenBelowThreshold = Math.max(24, Math.round(medianBlockSize * 0.25));
  const hiddenBefore = firstBlock.start >= hiddenAboveThreshold;
  const hiddenAfter =
    nativeScrollView.contentExtent - (lastBlock.start + lastBlock.size) >= hiddenBelowThreshold;

  return hiddenBefore || hiddenAfter ? { above: hiddenBefore, below: hiddenAfter } : null;
}

// fallow-ignore-next-line complexity
function estimateScrollOffset(
  nativeBlocks: FlowBlock[],
  visibleBlocks: FlowBlock[],
): number | null {
  const offsetBuckets = new Map<number, number[]>();
  for (const nativeBlock of nativeBlocks) {
    for (const visibleBlock of visibleBlocks) {
      if (!areFlowBlocksComparable(nativeBlock, visibleBlock)) {
        continue;
      }
      const offset = nativeBlock.start - visibleBlock.start;
      const bucket = Math.round(offset / 8) * 8;
      const values = offsetBuckets.get(bucket) ?? [];
      values.push(offset);
      offsetBuckets.set(bucket, values);
    }
  }

  let bestValues: number[] | null = null;
  for (const values of offsetBuckets.values()) {
    if (!bestValues || values.length > bestValues.length) {
      bestValues = values;
    }
  }
  if (!bestValues || bestValues.length < 2) {
    return null;
  }
  const sorted = [...bestValues].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function estimateEdgeAlignedScrollOffset(params: {
  nativeBlocks: FlowBlock[];
  visibleBlocks: FlowBlock[];
  viewportExtent: number;
  contentExtent: number;
}): number | null {
  const { nativeBlocks, visibleBlocks, viewportExtent, contentExtent } = params;
  const topAlignedOffsets: number[] = [];
  const bottomAlignedOffsets: number[] = [];

  for (const nativeBlock of nativeBlocks) {
    for (const visibleBlock of visibleBlocks) {
      if (!areFlowBlocksComparable(nativeBlock, visibleBlock)) {
        continue;
      }
      const offset = nativeBlock.start - visibleBlock.start;
      if (Math.abs(offset) <= 16) {
        topAlignedOffsets.push(offset);
      }
      if (Math.abs(offset + viewportExtent - contentExtent) <= 16) {
        bottomAlignedOffsets.push(offset);
      }
    }
  }

  if (bottomAlignedOffsets.length > 0) {
    return median(bottomAlignedOffsets);
  }
  if (topAlignedOffsets.length > 0) {
    return median(topAlignedOffsets);
  }
  return null;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function areFlowBlocksComparable(nativeBlock: FlowBlock, visibleBlock: FlowBlock): boolean {
  const sizeTolerance = Math.max(
    24,
    Math.round(Math.min(nativeBlock.size, visibleBlock.size) * 0.2),
  );
  const crossTolerance = Math.max(
    48,
    Math.round(Math.min(nativeBlock.crossSize, visibleBlock.crossSize) * 0.15),
  );
  return (
    Math.abs(nativeBlock.size - visibleBlock.size) <= sizeTolerance &&
    Math.abs(nativeBlock.crossSize - visibleBlock.crossSize) <= crossTolerance
  );
}

function collectVisibleFlowBlocks(
  nodes: RawSnapshotNode[],
  scrollNode: RawSnapshotNode,
): FlowBlock[] {
  const contentRoot = unwrapScrollableContentRoot(nodes, scrollNode);
  const children = nodes
    .filter((node) => node.parentIndex === contentRoot.index && node.rect)
    .map((node) => node.rect as Rect)
    .filter((rect) => hasPositiveVerticalExtent(rect))
    .sort((left, right) => left.y - right.y);

  return children.map((rect) => toFlowBlock(rect, scrollNode.rect as Rect));
}

function unwrapScrollableContentRoot(
  nodes: RawSnapshotNode[],
  scrollNode: RawSnapshotNode,
): RawSnapshotNode {
  let current = scrollNode;
  const visited = new Set<number>();
  while (!visited.has(current.index)) {
    visited.add(current.index);
    const children = nodes.filter((node) => node.parentIndex === current.index && node.rect);
    if (children.length !== 1) {
      return current;
    }
    const child = children[0] as RawSnapshotNode & { rect: Rect };
    if (!sameRect(child.rect, scrollNode.rect as Rect)) {
      return current;
    }
    current = child;
  }
  return scrollNode;
}

function collectNativeScrollViews(root: ViewNode): NativeScrollView[] {
  const results: NativeScrollView[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ViewNode;
    if (isScrollableType(node.className)) {
      const nativeScrollView = toNativeScrollView(node);
      if (nativeScrollView) {
        results.push(nativeScrollView);
      }
    }
    stack.push(...node.children);
  }
  return results;
}

function toNativeScrollView(node: ViewNode): NativeScrollView | null {
  const contentRoot = node.children[0];
  if (!contentRoot) {
    return null;
  }
  const contentExtent = Math.max(
    contentRoot.rect.height,
    ...contentRoot.children.map((child) => child.rect.y + child.rect.height),
  );
  const contentBlocks = contentRoot.children
    .filter((child) => hasPositiveVerticalExtent(child.rect))
    .map((child) => toFlowBlock(child.rect, node.rect))
    .sort((left, right) => left.start - right.start);
  if (contentBlocks.length === 0) {
    return null;
  }
  return {
    rect: node.rect,
    contentExtent,
    contentBlocks,
  };
}

function matchNativeScrollView(
  rect: Rect,
  nativeScrollViews: NativeScrollView[],
): NativeScrollView | null {
  let best: NativeScrollView | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const nativeScrollView of nativeScrollViews) {
    const sizeScore =
      Math.abs(nativeScrollView.rect.width - rect.width) +
      Math.abs(nativeScrollView.rect.height - rect.height);
    if (sizeScore > 32) {
      continue;
    }
    const positionScore =
      Math.abs(nativeScrollView.rect.x - rect.x) + Math.abs(nativeScrollView.rect.y - rect.y);
    const score = sizeScore * 4 + positionScore;
    if (score < bestScore) {
      best = nativeScrollView;
      bestScore = score;
    }
  }
  return best;
}

// fallow-ignore-next-line complexity
function parseActivityTopViewTree(dump: string): ViewNode | null {
  const root: ViewNode = {
    className: 'root',
    rect: { x: 0, y: 0, width: 0, height: 0 },
    children: [],
  };
  const stack: Array<{ indent: number; node: ViewNode }> = [{ indent: -1, node: root }];
  const lineRegex = /^(\s*)([\w.$]+)\{[^}]* (-?\d+),(-?\d+)-(-?\d+),(-?\d+) #/;

  for (const line of dump.split('\n')) {
    const match = lineRegex.exec(line);
    if (!match) {
      continue;
    }
    const [indentText, className, x1Text, y1Text, x2Text, y2Text] = match.slice(1);
    if (
      indentText === undefined ||
      className === undefined ||
      x1Text === undefined ||
      y1Text === undefined ||
      x2Text === undefined ||
      y2Text === undefined
    ) {
      continue;
    }
    const indent = indentText.length;
    const x1 = Number(x1Text);
    const y1 = Number(y1Text);
    const x2 = Number(x2Text);
    const y2 = Number(y2Text);
    const node: ViewNode = {
      className,
      rect: {
        x: x1,
        y: y1,
        width: Math.max(0, x2 - x1),
        height: Math.max(0, y2 - y1),
      },
      children: [],
    };
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ indent, node });
  }

  return root.children.length > 0 ? root : null;
}

function toFlowBlock(rect: Rect, viewportRect: Rect): FlowBlock {
  return {
    start: rect.y - viewportRect.y,
    size: rect.height,
    crossSize: rect.width,
  };
}

function hasPositiveVerticalExtent(rect: Rect): boolean {
  return rect.height > 0;
}

function sameRect(left: Rect, right: Rect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
