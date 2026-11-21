import { normalizeType, snapshotNodeKindIncludesAny } from './snapshot-text.ts';

/**
 * The scroll indicator's own names, spaced and unspaced: a producer spells it `ScrollBar` or
 * `UIScrollViewScrollIndicator`, and a web role carries the space. A fragment cannot tell these from
 * the containers they ride beside — `ScrollBar` carries the "scroll" fragment — so a caller that
 * would scroll, swipe inside, or clip by a node has to rule the indicator out by name first: a
 * command aimed at a scroll bar lands on a 3pt bar. The runner publishes the name now, which is what
 * surfaced the trap (#4657).
 */
const SCROLL_INDICATOR_KIND_FRAGMENTS = [
  'scrollbar',
  'scroll bar',
  'scrollindicator',
  'scroll indicator',
];

/** Whether `type` names a scroll indicator rather than the content a scroll moves. */
function isScrollIndicatorType(type: string): boolean {
  return snapshotNodeKindIncludesAny({ type }, SCROLL_INDICATOR_KIND_FRAGMENTS);
}

export function isScrollableType(type: string | null | undefined): boolean {
  const value = `${type ?? ''}`;
  if (!value || isScrollIndicatorType(value)) {
    return false;
  }
  const normalized = normalizeType(value);
  return (
    normalized.includes('scroll') ||
    normalized.includes('recyclerview') ||
    normalized.includes('listview') ||
    normalized.includes('gridview') ||
    normalized.includes('collectionview') ||
    normalized === 'collection' ||
    normalized === 'table'
  );
}

/** Whether a node names a scroll indicator — the bar or knob, not the content beside it. */
export function isScrollIndicatorNode(node: {
  type?: string | null;
  role?: string | null;
  subrole?: string | null;
}): boolean {
  return snapshotNodeKindIncludesAny(node, SCROLL_INDICATOR_KIND_FRAGMENTS);
}

export function isScrollableNodeLike(node: {
  type?: string | null;
  role?: string | null;
  subrole?: string | null;
}): boolean {
  if (isScrollIndicatorNode(node)) {
    return false;
  }
  if (isScrollableType(node.type)) {
    return true;
  }
  // A producer that states the fact in its class rather than its type answers here, which is why the
  // indicator is ruled out first: `_UIScrollViewScrollIndicator` says "scroll" and holds nothing.
  const role = `${node.role ?? ''} ${node.subrole ?? ''}`.toLowerCase();
  return role.includes('scroll');
}
