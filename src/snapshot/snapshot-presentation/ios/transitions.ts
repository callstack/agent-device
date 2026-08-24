import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { rectContains } from '@agent-device/kernel/rect';
import { extractNodeText, normalizeType } from '@agent-device/contracts/snapshot';
import {
  collectChildrenByParent,
  mergeReplacement,
  type SnapshotTreeRuleContext,
} from '../tree.ts';
import { collectIosReplacedActionShelves } from './action-shelf.ts';

const TITLE_PIECE_GAP_TOLERANCE = 12;

export function collectIosTransitionPresentation(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  const childrenByParent = collectChildrenByParent(nodes);
  collectIosReplacedActionShelves(nodes, childrenByParent, context);
  collectNavigationTitleAffordances(nodes, childrenByParent, context);
}

function collectNavigationTitleAffordances(
  nodes: RawSnapshotNode[],
  childrenByParent: ReadonlyMap<number, RawSnapshotNode[]>,
  context: SnapshotTreeRuleContext,
): void {
  for (const bar of nodes) {
    if (normalizeType(bar.type ?? '') !== 'navigationbar' || !bar.rect) continue;
    const children = childrenByParent.get(bar.index) ?? [];
    const candidates = children.flatMap((field) =>
      resolveNavigationTitleAffordance(field, children, bar.rect!),
    );
    if (candidates.length !== 1) continue;
    const { field, title, image, label } = candidates[0]!;
    mergeReplacement(context.replacements, field, {
      type: 'Button',
      label,
      enabled: true,
      rect: unionRects([image.rect!, field.rect!, title.rect!]),
    });
    context.semanticRepresentativeIndexes.add(field.index);
    context.suppressNode(title, [field]);
    context.suppressNode(image, [field]);
  }
}

function resolveNavigationTitleAffordance(
  field: RawSnapshotNode,
  siblings: RawSnapshotNode[],
  barRect: Rect,
): Array<{
  field: RawSnapshotNode;
  title: RawSnapshotNode;
  image: RawSnapshotNode;
  label: string;
}> {
  const label = extractNodeText(field);
  if (!isDisabledNavigationTitleField(field, label)) return [];
  const title = uniqueSibling(siblings, (node) => isMatchingTitle(node, label));
  const image = uniqueSibling(siblings, isNamedImage);
  return title?.rect &&
    image?.rect &&
    formsNavigationTitleAffordance(image.rect, field.rect!, title.rect, barRect)
    ? [{ field, title, image, label }]
    : [];
}

function isDisabledNavigationTitleField(field: RawSnapshotNode, label: string): boolean {
  return (
    normalizeType(field.type ?? '') === 'textfield' &&
    field.enabled === false &&
    Boolean(field.rect) &&
    Boolean(label) &&
    field.value?.trim() === label
  );
}

function isMatchingTitle(node: RawSnapshotNode, label: string): boolean {
  return (
    normalizeType(node.type ?? '') === 'statictext' &&
    node.label?.trim() === label &&
    Boolean(node.rect)
  );
}

function isNamedImage(node: RawSnapshotNode): boolean {
  return (
    normalizeType(node.type ?? '') === 'image' &&
    Boolean(node.identifier?.trim()) &&
    Boolean(node.rect)
  );
}

function uniqueSibling(
  siblings: RawSnapshotNode[],
  predicate: (node: RawSnapshotNode) => boolean,
): RawSnapshotNode | undefined {
  const matches = siblings.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function formsNavigationTitleAffordance(image: Rect, field: Rect, title: Rect, bar: Rect): boolean {
  const imageGap = field.x - (image.x + image.width);
  const titleGap = title.x - (field.x + field.width);
  return (
    rectContains(bar, image) &&
    rectContains(bar, field) &&
    rectContains(bar, title) &&
    imageGap >= 0 &&
    imageGap <= TITLE_PIECE_GAP_TOLERANCE &&
    titleGap >= 0 &&
    titleGap <= TITLE_PIECE_GAP_TOLERANCE &&
    verticallyOverlaps(image, field) &&
    verticallyOverlaps(field, title)
  );
}

function verticallyOverlaps(left: Rect, right: Rect): boolean {
  return Math.max(left.y, right.y) <= Math.min(left.y + left.height, right.y + right.height);
}

function unionRects(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}
