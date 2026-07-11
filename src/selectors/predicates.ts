import type { Platform, PublicPlatform } from '../kernel/device.ts';
import type { SnapshotState } from '../kernel/snapshot.ts';
import { isNodeVisibleInEffectiveViewport } from '../snapshot/mobile-snapshot-semantics.ts';
import { isNodeEditable, isNodeVisible } from './node.ts';
import { tryParseSelectorChain } from './parse.ts';
import {
  buildSnapshotNodeByIndex,
  extractNodeText,
  findSnapshotAncestor,
  normalizeType,
} from '../snapshot/snapshot-processing.ts';

export type IsPredicate =
  | 'visible'
  | 'hidden'
  | 'exists'
  | 'editable'
  | 'selected'
  | 'focused'
  | 'text';

export function isSupportedPredicate(input: string): input is IsPredicate {
  return ['visible', 'hidden', 'exists', 'editable', 'selected', 'focused', 'text'].includes(input);
}

export const IS_PREDICATE_REQUIRED_MESSAGE =
  'is requires predicate: visible|hidden|exists|editable|selected|focused|text';

export const IS_PREDICATE_USAGE_HINT =
  'Use "is <predicate> <selector>" or "is <selector> <predicate>". visible|hidden|editable|selected|focused double as selector keys: a bare predicate token after the selector is read as the predicate, so write key=true (e.g. visible=true) inside the selector to use it as a filter instead.';

// visible|hidden|editable|selected|focused double as selector boolean keys, so the selector-first
// form (`is <selector> <predicate>`) cannot survive greedy selector parsing: the trailing
// predicate token would be swallowed as a boolean selector term. Reserve the first bare
// predicate token that terminates a valid selector prefix and rotate the positionals into
// the canonical predicate-first shape.
export function normalizeIsPositionals(positionals: string[]): string[] {
  if (isSupportedPredicate((positionals[0] ?? '').toLowerCase())) return positionals;
  for (let i = 1; i < positionals.length; i += 1) {
    const candidate = (positionals[i] ?? '').toLowerCase();
    if (!isSupportedPredicate(candidate)) continue;
    if (!tryParseSelectorChain(positionals.slice(0, i).join(' '))) continue;
    return [candidate, ...positionals.slice(0, i), ...positionals.slice(i + 1)];
  }
  return positionals;
}

export function evaluateIsPredicate(params: {
  predicate: Exclude<IsPredicate, 'exists'>;
  node: SnapshotState['nodes'][number];
  nodes: SnapshotState['nodes'];
  expectedText?: string;
  platform: Platform | PublicPlatform;
}): { pass: boolean; actualText: string; details: string } {
  const { predicate, node, nodes, expectedText, platform } = params;
  const actualText = extractNodeText(node);
  const editable = isNodeEditable(node, platform);
  const selected = node.selected === true;
  const focused = node.focused === true;
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
    case 'focused':
      pass = focused;
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
          focused,
        })}`;
  return { pass, actualText, details };
}

function isAssertionVisible(
  node: SnapshotState['nodes'][number],
  nodes: SnapshotState['nodes'],
  platform: Platform | PublicPlatform,
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
  platform: Platform | PublicPlatform,
): SnapshotState['nodes'][number] | null {
  const nodesByIndex = buildSnapshotNodeByIndex(nodes);
  return findSnapshotAncestor(nodes, node, nodesByIndex, (parent) =>
    isUsefulVisibilityAnchor(parent, platform) ? parent : null,
  );
}

// fallow-ignore-next-line complexity
function isUsefulVisibilityAnchor(
  node: SnapshotState['nodes'][number],
  platform: Platform | PublicPlatform,
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
