import type { Platform } from '../kernel/device.ts';
import type { SnapshotState } from '../kernel/snapshot.ts';
import { isNodeVisibleInEffectiveViewport } from '../snapshot/mobile-snapshot-semantics.ts';
import { isNodeEditable, isNodeVisible } from './selector-node.ts';
import {
  buildSnapshotNodeByIndex,
  extractNodeText,
  findSnapshotAncestor,
  normalizeType,
} from '../snapshot/snapshot-processing.ts';

export type IsPredicate = 'visible' | 'hidden' | 'exists' | 'editable' | 'selected' | 'text';

export function isSupportedPredicate(input: string): input is IsPredicate {
  return ['visible', 'hidden', 'exists', 'editable', 'selected', 'text'].includes(input);
}

export function evaluateIsPredicate(params: {
  predicate: Exclude<IsPredicate, 'exists'>;
  node: SnapshotState['nodes'][number];
  nodes: SnapshotState['nodes'];
  expectedText?: string;
  platform: Platform;
}): { pass: boolean; actualText: string; details: string } {
  const { predicate, node, nodes, expectedText, platform } = params;
  const actualText = extractNodeText(node);
  const editable = isNodeEditable(node, platform);
  const selected = node.selected === true;
  const visible =
    predicate === 'text' ? isNodeVisible(node) : isAssertionVisible(node, nodes, platform);
  let pass = false;
  switch (predicate) {
    case 'visible':
      pass = visible;
      break;
    case 'hidden':
      pass = !visible;
      break;
    case 'editable':
      pass = editable;
      break;
    case 'selected':
      pass = selected;
      break;
    case 'text':
      pass = actualText === (expectedText ?? '');
      break;
  }
  const details =
    predicate === 'text'
      ? `expected="${expectedText ?? ''}" actual="${actualText}"`
      : `actual=${JSON.stringify({
          visible,
          editable,
          selected,
        })}`;
  return { pass, actualText, details };
}

function isAssertionVisible(
  node: SnapshotState['nodes'][number],
  nodes: SnapshotState['nodes'],
  platform: Platform,
): boolean {
  if (platform === 'android' && node.visibleToUser === false) return false;
  if (hasPositiveRect(node.rect)) return isRectVisibleInViewport(node, nodes);
  if (node.rect) return false;
  if (platform !== 'android' && node.hittable === true) return true;
  const anchor = resolveVisibilityAnchor(node, nodes, platform);
  if (!anchor) return false;
  if (!hasPositiveRect(anchor.rect)) return platform !== 'android' && anchor.hittable === true;
  return isRectVisibleInViewport(anchor, nodes);
}

function isRectVisibleInViewport(
  node: SnapshotState['nodes'][number],
  nodes: SnapshotState['nodes'],
): boolean {
  return isNodeVisibleInEffectiveViewport(node, nodes);
}

function resolveVisibilityAnchor(
  node: SnapshotState['nodes'][number],
  nodes: SnapshotState['nodes'],
  platform: Platform,
): SnapshotState['nodes'][number] | null {
  const nodesByIndex = buildSnapshotNodeByIndex(nodes);
  return findSnapshotAncestor(nodes, node, nodesByIndex, (parent) =>
    isUsefulVisibilityAnchor(parent, platform) ? parent : null,
  );
}

// fallow-ignore-next-line complexity
function isUsefulVisibilityAnchor(
  node: SnapshotState['nodes'][number],
  platform: Platform,
): boolean {
  if (platform === 'android' && node.visibleToUser === false) return false;
  const type = normalizeType(node.type ?? '');
  // These containers often report the full content frame, not the clipped on-screen geometry.
  if (
    type.includes('application') ||
    type.includes('window') ||
    type.includes('scrollview') ||
    type.includes('tableview') ||
    type.includes('collectionview') ||
    type === 'table' ||
    type === 'list' ||
    type === 'listview'
  ) {
    return false;
  }
  if (platform === 'android') {
    return node.hittable === true && hasPositiveRect(node.rect);
  }
  return node.hittable === true || hasPositiveRect(node.rect);
}

function hasPositiveRect(
  rect: SnapshotState['nodes'][number]['rect'],
): rect is NonNullable<SnapshotState['nodes'][number]['rect']> {
  return Boolean(
    rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0,
  );
}
